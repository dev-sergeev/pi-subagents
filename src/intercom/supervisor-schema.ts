import { Type } from "typebox";

export const ContactSupervisorParamsSchema = Type.Object({
	reason: Type.String({ enum: ["need_decision", "interview_request", "progress_update"], description: "need_decision waits for a supervisor decision; interview_request waits for structured JSON input; progress_update delivers a non-blocking update." }),
	message: Type.Optional(Type.String({ maxLength: 65_536, description: "Question or progress update for the supervisor. Required and non-empty for need_decision and progress_update; optional when the interview object supplies the request." })),
	interview: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Structured interview request describing the expected JSON reply shape or questions (for example title and questions). Passed to the supervisor as an object; its JSON reply is returned as structuredReply, or structuredReplyParseError when parsing fails." })),
}, { additionalProperties: false });
