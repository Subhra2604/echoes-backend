import type { Request, Response, NextFunction } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { Errors } from '../lib/errors.js';

type Schemas = { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny };

/** Validate and coerce request parts; replaces them with the parsed values. */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) {
        // req.query is a GETTER in Express 5 (it re-parses the raw URL on
        // every access, see express/lib/request.js) — it is not a stable
        // object, so Object.assign(req.query, ...) mutates a throwaway value
        // that the next read of req.query discards. Overriding the property
        // itself (it's declared `configurable: true`) makes the parsed/
        // coerced/defaulted result the value every later read actually sees,
        // for the rest of this request.
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      if (schemas.params) Object.assign(req.params, schemas.params.parse(req.params));
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        next(Errors.badRequest('Validation failed', err.flatten().fieldErrors));
      } else {
        next(err);
      }
    }
  };
}
