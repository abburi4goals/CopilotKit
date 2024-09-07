import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit-alt/runtime";
import { research } from "./tavily";
import { NextRequest } from "next/server";

export const POST = async (req: NextRequest) => {
  const serviceAdapter = new OpenAIAdapter();

  const actions: any[] = [];

  if ("TAVILY_API_KEY" in process.env) {
    actions.push({
      name: "research",
      description:
        "Call this function to conduct research on a certain topic. Respect other notes about when to call this function",
      parameters: [
        {
          name: "topic",
          type: "string",
          description: "The topic to research. 5 characters or longer.",
        },
      ],
      handler: async ({ topic }) => {
        console.log("Researching topic: ", topic);
        return await research(topic);
      },
    });
  }
  const runtime = new CopilotRuntime({ actions });
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: req.nextUrl.pathname,
  });

  return handleRequest(req);
};
