import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user.type';

/**
 * Global authentication guard. `@Public()` routes are *optionally*
 * authenticated rather than skipped: a request without a token still gets
 * through, but one carrying a valid token has `request.user` populated. Several
 * public endpoints legitimately change shape for a signed-in viewer — the
 * catalog shows exact stock quantities to staff and only a status badge to
 * everyone else (doc 3.2) — and that only works if the token is read here.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  private isPublic(context: ExecutionContext) {
    return this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  handleRequest<TUser = AuthenticatedUser>(
    err: unknown,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    // On a public route an absent or unusable token is not an error — the
    // handler simply sees an anonymous visitor.
    if (this.isPublic(context)) return (user || undefined) as TUser;

    if (err || !user) throw err instanceof Error ? err : new UnauthorizedException();
    return user;
  }
}
