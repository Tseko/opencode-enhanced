/**
 * Terminal reason written to an assistant message when a turn stops because the agent's step
 * allowance was exhausted. Consumers must surface it distinctly (the task tool reports
 * `reason: turn_limit`) instead of collapsing the turn into success.
 *
 * It travels as an `UnknownError` message because the durable V1 message error union has no
 * dedicated step-limit variant, and adding one would change the shared message schema.
 */
export const TURN_LIMIT_REASON = "Maximum agent steps reached"

export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`
