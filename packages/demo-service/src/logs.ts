const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** nginx-style access log line with the request and operation identifiers appended. */
export function edgeAccessLine(input: {
  at: Date;
  status: number;
  bytes: number;
  requestTimeSeconds: number;
  requestId: string;
  operationId: string;
}): string {
  const t = input.at;
  const stamp = `${pad(t.getUTCDate())}/${MONTHS[t.getUTCMonth()]}/${t.getUTCFullYear()}:${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} +0000`;
  return (
    `10.0.0.5 - - [${stamp}] "POST /v1/extract HTTP/1.1" ${input.status} ${input.bytes} "-" "settleback-buyer/1.0" ` +
    `request_time=${input.requestTimeSeconds.toFixed(3)} request_id=${input.requestId} operation_id=${input.operationId}`
  );
}

/** Application log line in the worker's own format and clock; it knows only its job alias. */
export function workerLine(input: { at: Date; level: "INFO" | "WARN" | "ERROR"; alias: string; message: string }): string {
  const t = input.at;
  const stamp =
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())},${pad(t.getUTCMilliseconds(), 3)}`;
  return `${stamp} ${input.level.padEnd(5)} [${input.alias}] ${input.message}`;
}
