import { BadRequestException, type ValidationError } from '@nestjs/common';

/** One failed rule on one field, in a form the client can translate. */
export interface FieldError {
  /** Dotted path of the field, e.g. `delivery.city`. */
  field: string;
  /** The class-validator rule that failed, e.g. `isNotEmpty`, `maxLength`. */
  constraint: string;
  /** The English text class-validator produced (kept for callers that don't translate). */
  message: string;
  /** The number a rule refers to (`maxLength` 120, `max` 5000, …), when it has one. */
  limit?: number;
}

const flatten = (errors: ValidationError[], parent = ''): FieldError[] =>
  errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.entries(error.constraints ?? {}).map(([constraint, message]): FieldError => {
      const limit = /(-?\d+(?:\.\d+)?)/.exec(message)?.[1];
      return {
        field,
        constraint,
        message,
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      };
    });
    return [...own, ...flatten(error.children ?? [], field)];
  });

/**
 * Turns a failed DTO validation into a 400 that keeps the old shape (`message`
 * is still the list of English sentences) and adds `code` and `errors`, so the
 * client can say "Address is required" in the user's language, field by field.
 */
export const validationException = (errors: ValidationError[]): BadRequestException => {
  const fields = flatten(errors);
  return new BadRequestException({
    message: fields.map((field) => field.message),
    code: 'validation.failed',
    errors: fields,
  });
};
