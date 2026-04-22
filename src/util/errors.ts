export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export class UpstreamError extends HttpError {
  constructor(message: string, public readonly upstream?: string) {
    super(502, message, 'upstream_error');
    this.name = 'UpstreamError';
  }
}

export class ModuleUnavailableError extends HttpError {
  constructor(module: string, detail?: string) {
    super(503, `module ${module} is not available${detail ? `: ${detail}` : ''}`, 'module_unavailable');
    this.name = 'ModuleUnavailableError';
  }
}
