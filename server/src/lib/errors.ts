export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: string = 'app_error',
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, message, 'not_found');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message, 'forbidden');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'unauthorized');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid input') {
    super(400, message, 'validation_error');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, message, 'conflict');
  }
}
