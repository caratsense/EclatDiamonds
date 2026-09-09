import { SetMetadata } from '@nestjs/common';

/**
 * Route markers for machine (CaratOS Connect agent) principals — Phase B2.
 *
 * ## The problem these close
 *
 * The on-site sync agent authenticates by logging in as a dedicated
 * **head_office user account**. That account is a person as far as the app is
 * concerned, so a token sitting on a shop-floor PC in Surat carries every
 * head-office permission in the product: approving discounts, changing roles,
 * reading organisation-wide finance — and, worst, the four destructive sync
 * routes (`purge-demo`, `reset`, `prune-stores`, `reset-users`).
 *
 * That is a large blast radius for a credential stored in a config file on a
 * machine the business does not manage.
 *
 * ## What replaces it
 *
 * `@AllowMachine()` marks the routes an agent may reach — the bulk-ingestion
 * endpoints and nothing else. The agent presents its own `ConnectAgent` token
 * (already hashed at rest, rotatable, revocable per machine) instead of a user
 * password, and `JwtAuthGuard` resolves it to a principal flagged `isMachine`.
 *
 * `@HumansOnly()` marks the routes a machine must never reach even if it somehow
 * held a valid token. Applied to everything destructive.
 *
 * ## Why not simply lower the agent's role
 *
 * Because bulk ingestion genuinely needs organisation-wide write reach — that is
 * what a sync IS. The problem was never the reach, it was that the credential
 * was indistinguishable from a person's. Marking the principal keeps the reach
 * and restores the distinction.
 *
 * Legacy ingestion is intentionally NOT backward compatible with a human
 * service-account JWT: those routes require the restricted machine principal.
 * Human operators retain the explicitly human-only repair controls.
 */

export const ALLOW_MACHINE_KEY = 'allowMachine';
export const HUMANS_ONLY_KEY = 'humansOnly';
export const ORGANISATION_WIDE_MACHINE_KEY = 'organisationWideMachine';

export type MachineAccess = true | readonly string[];

/**
 * This route accepts a CaratOS Connect agent token as well as a user JWT.
 * Pass source-system names on ingestion routes to restrict which enrolled
 * connector may use them. The broad form is reserved for `/me` and heartbeat.
 */
export const AllowMachine = (...sourceSystems: string[]) =>
  SetMetadata(
    ALLOW_MACHINE_KEY,
    sourceSystems.length ? Object.freeze([...sourceSystems]) : true,
  );

/** A machine may enter only when its enrolment is not bound to one store. */
export const OrganisationWideMachineOnly = () =>
  SetMetadata(ORGANISATION_WIDE_MACHINE_KEY, true);

/**
 * This route refuses machine principals outright. Use on anything that deletes,
 * resets or purges: a person has to be the one who decides that.
 */
export const HumansOnly = () => SetMetadata(HUMANS_ONLY_KEY, true);
