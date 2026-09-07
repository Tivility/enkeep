/**
 * Error classes and codes for CLI Tool Subsystem
 *
 * @module @enkeep/dsh-tool-cli/errors
 */

export class CliToolError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(message: string, code = 'CLI_TOOL_ERROR', status = 500, details?: unknown) {
    super(message);
    this.name = 'CliToolError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, CliToolError.prototype);
  }
}
