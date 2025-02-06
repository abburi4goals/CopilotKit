"""
Utils
"""

import asyncio
import contextvars
import json
import traceback
from typing_extensions import Coroutine, Any, Dict, Optional, Literal, List, TypedDict
from .protocol import (
  RuntimeEvent,
  RuntimeEventTypes,
  emit_runtime_event,
  agent_state_message,
)

async def yield_control():
    """
    Yield control to the event loop.
    """
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    loop.call_soon(future.set_result, None)
    await future

_CONTEXT_QUEUE = contextvars.ContextVar('queue', default=None)

def get_context_queue() -> asyncio.Queue:
    """
    Retrieve the queue from this task's context.
    """
    q = _CONTEXT_QUEUE.get()
    if q is None:
        raise RuntimeError("No context queue is set!")
    return q

def set_context_queue(q: asyncio.Queue) -> contextvars.Token:
    """
    Set the queue in this task's context.
    """
    token = _CONTEXT_QUEUE.set(q)
    return token

def reset_context_queue(token: contextvars.Token):
    """
    Reset the queue in this task's context.
    """
    _CONTEXT_QUEUE.reset(token)

async def queue_put(*events: RuntimeEvent) -> Literal[True]:
    """
    Put an event in the queue.
    """
    q = get_context_queue()
    for event in events:
        await q.put(event)
    await yield_control()

    return True

def _filter_state(
        *,
        state: Dict[str, Any],
        exclude_keys: Optional[List[str]] = None
    ) -> Dict[str, Any]:
    """Filter out messages and id from the state"""
    exclude_keys = exclude_keys or ["messages", "id"]
    return {k: v for k, v in state.items() if k not in exclude_keys}

class CopilotKitRunExecution(TypedDict):
    """
    CopilotKit Run Execution
    """
    should_exit: bool
    node_name: str
    is_finished: bool
    predict_state_configuration: Dict[str, Any]
    predicted_state: Dict[str, Any]
    argument_buffer: str
    current_tool_call: Optional[str]
    state: Dict[str, Any]

async def copilotkit_run(
        task: Coroutine,
        *,
        thread_id: str,
        agent_name: str,
        run_id: str,
        execution: CopilotKitRunExecution
):
    """
    Run a task with a local queue.
    """
    local_queue = asyncio.Queue()
    token = set_context_queue(local_queue)

    try:
        while True:
            event = await local_queue.get()
            local_queue.task_done()

            json_lines = handle_runtime_event(
                event=event,
                thread_id=thread_id,
                agent_name=agent_name,
                run_id=run_id,
                execution=execution
            )

            if json_lines is not None:
                yield json_lines

            if execution["is_finished"]:
                break

            # return control to the containing run loop to send events
            await yield_control()

        await task
    finally:
        reset_context_queue(token)

def handle_runtime_event(
        *,
        event: RuntimeEvent,
        thread_id: str,
        agent_name: str,
        run_id: str,
        execution: CopilotKitRunExecution
) -> Optional[str]:
    """
    Handle a runtime event.
    """

    if event["type"] in [
        RuntimeEventTypes.TEXT_MESSAGE_START,
        RuntimeEventTypes.TEXT_MESSAGE_CONTENT,
        RuntimeEventTypes.TEXT_MESSAGE_END,
        RuntimeEventTypes.ACTION_EXECUTION_START,
        RuntimeEventTypes.ACTION_EXECUTION_ARGS,
        RuntimeEventTypes.ACTION_EXECUTION_END,
        RuntimeEventTypes.ACTION_EXECUTION_RESULT,
        RuntimeEventTypes.AGENT_STATE_MESSAGE,
        RuntimeEventTypes.META_EVENT
    ]:
        return emit_runtime_event(event)

    if event["type"] == RuntimeEventTypes.RUN_STARTED:
        execution["state"] = event["state"]
        return None

    if event["type"] == RuntimeEventTypes.NODE_STARTED:
        execution["node_name"] = event["name"]
        execution["state"] = event["state"]

        return emit_runtime_event(
            agent_state_message(
                thread_id=thread_id,
                agent_name=agent_name,
                node_name=execution["node_name"],
                run_id=run_id,
                active=True,
                role="assistant",
                state=json.dumps(_filter_state(state=execution["state"])),
                running=True
            )
        )

    if event["type"] == RuntimeEventTypes.NODE_FINISHED:

        # reset the predict state configuration at the end of the method execution
        execution["predict_state_configuration"] = {}
        execution["current_tool_call"] = None
        execution["argument_buffer"] = ""
        execution["predicted_state"] = {}
        execution["state"] = event["state"]

        return emit_runtime_event(
            agent_state_message(
                thread_id=thread_id,
                agent_name=agent_name,
                node_name=execution["node_name"],
                run_id=run_id,
                active=False,
                role="assistant",
                state=json.dumps(_filter_state(state=execution["state"])),
                running=True
            )
        )

    if event["type"] == RuntimeEventTypes.RUN_FINISHED:
        execution["is_finished"] = True
        return None

    if event["type"] == RuntimeEventTypes.RUN_ERROR:
        print("Flow execution error", flush=True)
        error_info = event["error"]

        if isinstance(error_info, Exception):
            # If it's an exception, print the traceback
            print("Exception occurred:", flush=True)
            print(
                ''.join(
                    traceback.format_exception(
                        None,
                        error_info,
                        error_info.__traceback__
                    )
                ),
                flush=True
            )
        else:
            # Otherwise, assume it's a string and print it
            print(error_info, flush=True)

        execution["is_finished"] = True
        return None
