/** Structured error hierarchy for Tasknest. */
export class TasknestError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export class ConfigError extends TasknestError {
  constructor(message: string) {
    super(message, 2);
  }
}

export class DiscoveryError extends TasknestError {
  constructor(message: string) {
    super(message, 2);
  }
}

export class ValidationError extends TasknestError {
  constructor(message: string) {
    super(message, 2);
  }
}

export class DependencyError extends TasknestError {
  constructor(message: string) {
    super(message, 2);
  }
}

export class ToolError extends TasknestError {
  constructor(message: string, exitCode = 1) {
    super(message, exitCode);
  }
}

export class NotImplementedError extends TasknestError {
  constructor(message: string) {
    super(message, 2);
  }
}
