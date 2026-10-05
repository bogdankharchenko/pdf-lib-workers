export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 413 | 422 | 500 | 502 | 504,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
