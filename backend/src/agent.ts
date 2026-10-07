import {
  Annotation,
  END,
  LangGraphRunnableConfig,
  Send,
  StateGraph,
  messagesStateReducer,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { CallbackHandler } from '@langfuse/langchain';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';

import { buildSystemPrompt } from './prompt.js';
import {
  validateGoogleToken,
  verifyThreadAuthorization,
} from './utils/auth.js';
import { stampLatestHumanMessage, stampMessage } from './utils/timestamp.js';
import { getTimezone } from './utils/tool-config.js';
import { selectModelContext, windowMessages } from './utils/window-messages.js';
import { calendarTools } from './tools/calendar.js';
import { gmailTools } from './tools/gmail.js';
import { taskTools } from './tools/tasks.js';

const allTools = [...calendarTools, ...taskTools, ...gmailTools];

// A tool round is one model turn that calls tools plus the tools' results.
// Ten rounds keeps the forced final answer inside the default recursion limit
// of 25 steps: preprocess, two steps per round, then the answer.
const MAX_TOOL_ROUNDS = 10;

const TOOL_BUDGET_REPLY =
  'I ran out of tool calls for this request before I could finish. Try narrowing it, for example to a date range or a sender.';

function countToolRounds(messages: BaseMessage[]): number {
  let rounds = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;

    if (HumanMessage.isInstance(message)) {
      break;
    }

    if (
      AIMessage.isInstance(message) &&
      (message.tool_calls?.length ?? 0) > 0
    ) {
      rounds += 1;
    }
  }

  return rounds;
}

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

function getModel(): ChatGoogleGenerativeAI {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required');
  }

  return new ChatGoogleGenerativeAI({
    apiKey,
    model: 'gemini-3.1-flash-lite',
    temperature: 0,
  });
}

function preprocessMessages(messages: BaseMessage[]): {
  messages: BaseMessage[];
} {
  const now = Date.now();
  const stampedMessages = stampLatestHumanMessage(messages, now);
  const windowedMessages = windowMessages(stampedMessages, { now });

  return {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      ...windowedMessages,
    ],
  };
}

async function preprocessNode(
  state: typeof AgentState.State,
  config: LangGraphRunnableConfig,
) {
  const { email } = await validateGoogleToken(config);
  verifyThreadAuthorization(config, email);

  return preprocessMessages(state.messages);
}

const toolNode = new ToolNode(allTools);

// The input ToolNode reads when it runs a single call sent to it.
const ToolCallTask = Annotation.Root({
  lg_tool_call: Annotation<ToolCall>(),
});

// One task per tool call. LangGraph matches approvals to a task and reruns an
// interrupted task whole, so calls sharing one swap approvals and repeat writes.
function routeToolCalls(state: typeof AgentState.State) {
  const lastMessage = state.messages.at(-1);
  const toolCalls = AIMessage.isInstance(lastMessage)
    ? (lastMessage.tool_calls ?? [])
    : [];

  return toolCalls.length > 0
    ? toolCalls.map((toolCall) => new Send('tools', { lg_tool_call: toolCall }))
    : END;
}

async function toolsNode(
  task: typeof ToolCallTask.State,
  config: LangGraphRunnableConfig,
) {
  const result = (await toolNode.invoke(
    task,
    config,
  )) as typeof AgentState.State;

  return {
    messages: result.messages.map((m) => stampMessage(m)),
  };
}

export const workflow = new StateGraph(AgentState)
  .addNode('preprocess', preprocessNode)
  .addNode('agent', async (state, config) => {
    const toolBudgetExhausted =
      countToolRounds(state.messages) >= MAX_TOOL_ROUNDS;
    const response = await getModel()
      .bindTools(
        allTools,
        toolBudgetExhausted ? { tool_choice: 'none' } : undefined,
      )
      .invoke([
        new SystemMessage(
          buildSystemPrompt({
            timezone: getTimezone(config),
            toolBudgetExhausted,
          }),
        ),
        ...selectModelContext(state.messages),
      ]);

    // Gemini 3.1 flash-lite has returned tool calls despite NONE mode, so
    // this replacement, not the mode, is what actually ends the loop.
    if (toolBudgetExhausted && (response.tool_calls?.length ?? 0) > 0) {
      return { messages: [stampMessage(new AIMessage(TOOL_BUDGET_REPLY))] };
    }

    return { messages: [stampMessage(response)] };
  })
  .addNode('tools', toolsNode, { input: ToolCallTask })
  .addEdge('__start__', 'preprocess')
  .addEdge('preprocess', 'agent')
  .addConditionalEdges('agent', routeToolCalls, ['tools', '__end__'])
  .addEdge('tools', 'agent');

// Tracing is fail-open: without Langfuse keys no span processor is registered,
// so the handler's spans hit a no-op tracer and runs proceed untraced.
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] }).start();
}

export const graph = workflow.compile().withConfig({
  callbacks: [new CallbackHandler()],
});
