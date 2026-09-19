import { createHash, timingSafeEqual } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';

/** Every path Swagger serves: the UI (+ its assets), and the raw JSON/YAML documents. */
export const DOCS_PATHS = ['/docs', '/docs-json', '/docs-yaml'] as const;

export interface DocsSettings {
  /** Whether the API docs are served at all. */
  enabled: boolean;
  /** When both are set, the docs sit behind HTTP Basic auth. */
  user?: string;
  password?: string;
}

/**
 * The interactive docs list every route, DTO and role rule — useful in
 * development, but a map for an attacker in production. So: on by default
 * everywhere except production, and in production only when explicitly
 * switched on with `SWAGGER_ENABLED=true` (which then also requires
 * credentials — see `validation.schema.ts`).
 */
export const resolveDocsEnabled = (env: string, explicit?: string): boolean => {
  if (explicit !== undefined && explicit.trim() !== '')
    return explicit.trim().toLowerCase() === 'true';
  return env !== 'production';
};

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Compares in constant time (hashing first, so length differences don't leak either). */
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** HTTP Basic auth middleware for the docs routes. */
export const docsBasicAuth =
  (user: string, password: string) => (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator !== -1) {
        const givenUser = decoded.slice(0, separator);
        const givenPassword = decoded.slice(separator + 1);
        // Both compared unconditionally so a wrong user name isn't distinguishable from a wrong password by timing.
        const userOk = safeEqual(givenUser, user);
        const passwordOk = safeEqual(givenPassword, password);
        if (userOk && passwordOk) {
          next();
          return;
        }
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Magnificat API docs", charset="UTF-8"');
    res.status(401).send('Authentication required.');
  };

/** Mounts the Swagger UI per `settings`; does nothing (no route, no JSON document) when disabled. */
export const setupSwagger = (app: INestApplication, settings: DocsSettings) => {
  if (!settings.enabled) return;

  if (settings.user && settings.password) {
    app.use([...DOCS_PATHS], docsBasicAuth(settings.user, settings.password));
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Magnificat Smart Space API')
    .setDescription(
      'E-commerce, 3D room visualizer and AI chatbot backend for Magnificat Smart Space.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
};
