import {
  Action,
  ToolDefinition,
  EXCLUDE_FROM_FORWARD_PROPS_KEYS,
  actionToChatCompletionFunction,
  Parameter,
  AnnotatedFunction,
  annotatedFunctionToAction,
} from "@copilotkit/shared";
import {
  SingleChunkReadableStream,
  copilotkitStreamInterceptor,
  remoteChainToAction,
} from "../utils";
import { RemoteChain, CopilotKitServiceAdapter } from "../types";
import { cloudCheckGuardrailsInput } from "./cloud";

interface CopilotBackendResult {
  stream: ReadableStream;
  headers?: Record<string, string>;
}

interface CopilotBackendConstructorParams<T extends Parameter[] | [] = []> {
  actions?: Action<T>[];
  langserve?: RemoteChain[];
  debug?: boolean;
}

interface CopilotDeprecatedBackendConstructorParams<T extends Parameter[] | [] = []> {
  actions?: AnnotatedFunction<any>[];
  langserve?: RemoteChain[];
  debug?: boolean;
}

const CONTENT_POLICY_VIOLATION_RESPONSE =
  "Thank you for your request. Unfortunately, we're unable to fulfill it as it doesn't align with our content policy. We appreciate your understanding.";

export class CopilotBackend<const T extends Parameter[] | [] = []> {
  private actions: Action<any>[] = [];
  private langserve: Promise<Action<any>>[] = [];
  private debug: boolean = false;

  constructor(params?: CopilotBackendConstructorParams<T>);
  // @deprecated use Action<T> instead of AnnotatedFunction<T>
  constructor(params?: CopilotDeprecatedBackendConstructorParams<T>);
  constructor(
    params?: CopilotBackendConstructorParams<T> | CopilotDeprecatedBackendConstructorParams<T>,
  ) {
    for (const action of params?.actions || []) {
      if ("argumentAnnotations" in action) {
        this.actions.push(annotatedFunctionToAction(action));
      } else {
        this.actions.push(action);
      }
    }
    for (const chain of params?.langserve || []) {
      this.langserve.push(remoteChainToAction(chain));
    }
    this.debug = params?.debug || false;
  }

  addAction<const T extends Parameter[] | [] = []>(action: Action<T>): void;
  /** @deprecated Use addAction with Action<T> instead. */
  addAction(action: AnnotatedFunction<any>): void;
  addAction<const T extends Parameter[] | [] = []>(
    action: Action<T> | AnnotatedFunction<any>,
  ): void {
    this.removeAction(action.name);
    if ("argumentAnnotations" in action) {
      this.actions.push(annotatedFunctionToAction(action));
    } else {
      this.actions.push(action);
    }
  }

  removeAction(actionName: string): void {
    this.actions = this.actions.filter((f) => f.name !== actionName);
  }

  removeBackendOnlyProps(forwardedProps: any): void {
    // Get keys backendOnlyPropsKeys in order to remove them from the forwardedProps
    const backendOnlyPropsKeys = forwardedProps[EXCLUDE_FROM_FORWARD_PROPS_KEYS];
    if (Array.isArray(backendOnlyPropsKeys)) {
      backendOnlyPropsKeys.forEach((key) => {
        const success = Reflect.deleteProperty(forwardedProps, key);
        if (!success) {
          console.error(`Failed to delete property ${key}`);
        }
      });
      // After deleting individual backend-only properties, delete the EXCLUDE_FROM_FORWARD_PROPS_KEYS property itself from forwardedProps
      const success = Reflect.deleteProperty(forwardedProps, EXCLUDE_FROM_FORWARD_PROPS_KEYS);
      if (!success) {
        console.error(`Failed to delete EXCLUDE_FROM_FORWARD_PROPS_KEYS`);
      }
    } else if (backendOnlyPropsKeys) {
      console.error("backendOnlyPropsKeys is not an array");
    }
  }

  private async getResponse(
    forwardedProps: any,
    serviceAdapter: CopilotKitServiceAdapter,
  ): Promise<CopilotBackendResult> {
    this.removeBackendOnlyProps(forwardedProps);

    // In case Copilot Cloud is configured remove it from the forwardedProps
    const cloud = forwardedProps.cloud;
    delete forwardedProps.cloud;

    // if an API key is set, log the chat to Copilot Cloud
    const cloudCheckGuardrailsInputPromise = cloud
      ? cloudCheckGuardrailsInput(forwardedProps, cloud)
      : Promise.resolve("allowed");

    const langserveFunctions: Action<any>[] = [];

    for (const chainPromise of this.langserve) {
      try {
        const chain = await chainPromise;
        langserveFunctions.push(chain);
      } catch (error) {
        console.error("Error loading langserve chain:", error);
      }
    }

    // merge server side functions with langserve functions
    let mergedTools = mergeServerSideTools(
      this.actions.map(actionToChatCompletionFunction),
      langserveFunctions.map(actionToChatCompletionFunction),
    );

    // merge with client side functions
    mergedTools = mergeServerSideTools(mergedTools, forwardedProps.tools);

    try {
      const result = await serviceAdapter.getResponse({
        ...forwardedProps,
        tools: mergedTools,
      });

      // wait for the cloud log chat to finish before streaming back the response
      // NOTE: in case there was no API key set, this will resolve immediately
      try {
        const status = await cloudCheckGuardrailsInputPromise;
        if (status === "denied") {
          // the chat was denied. instead of streaming back the response,
          // we let the client know...
          // TODO- this should not be a hardcoded message
          return {
            stream: new SingleChunkReadableStream(CONTENT_POLICY_VIOLATION_RESPONSE),
            headers: result.headers,
          };
        }
      } catch (error) {
        console.error("Error checking guardrails:", error);
      }

      const stream = copilotkitStreamInterceptor(
        result.stream,
        [...this.actions, ...langserveFunctions],
        this.debug,
      );
      return { stream, headers: result.headers };
    } catch (error) {
      console.error("Error getting response:", error);
      throw error;
    }
  }

  async response(req: Request, serviceAdapter: CopilotKitServiceAdapter): Promise<Response> {
    try {
      const response = await this.getResponse(await req.json(), serviceAdapter);
      return new Response(response.stream, { headers: response.headers });
    } catch (error: any) {
      return new Response("", { status: 500, statusText: error.message });
    }
  }

  async streamHttpServerResponse(
    req: any,
    res: any,
    serviceAdapter: CopilotKitServiceAdapter,
    headers?: Record<string, string>,
  ) {
    const bodyParser = new Promise<any>((resolve, reject) => {
      if ("body" in req) {
        resolve(req.body);
        return;
      }
      let body = "";
      req.on("data", (chunk: any) => (body += chunk.toString()));
      req.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    const forwardedProps = await bodyParser;
    const response = await this.getResponse(forwardedProps, serviceAdapter);
    const mergedHeaders = { ...headers, ...response.headers };
    res.writeHead(200, mergedHeaders);
    const stream = response.stream;
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        break;
      } else {
        res.write(new TextDecoder().decode(value));
      }
    }
  }
}

export function mergeServerSideTools(
  serverTools: ToolDefinition[],
  clientTools?: ToolDefinition[],
) {
  let allTools: ToolDefinition[] = serverTools.slice();
  const serverToolsNames = serverTools.map((tool) => tool.function.name);
  if (clientTools) {
    allTools = allTools.concat(
      // filter out any client functions that are already defined on the server
      clientTools.filter((tool: ToolDefinition) => !serverToolsNames.includes(tool.function.name)),
    );
  }
  return allTools;
}
