/**
 * Where each builtin ACP profile's binary comes from.
 *
 * Adapter facts live in the standalone `Moonrend/acp-registry` repo, not here.
 * This module only decides *how* to obtain an adapter: a published image when
 * the registry has one, on-demand provisioning otherwise. Adding an adapter is
 * a pull request against that repo — no change in Zakura.
 */

import {
  acpAgentByProfile,
  acpAgents,
  acpImageAtVersion,
} from "./acp-registry-client.js";

export type AcpAdapterSource =
  /** Provision from the upstream registry under this id. */
  | { kind: "registry"; registryId: string }
  /** Present in the image already; nothing to install. */
  | { kind: "image" }
  /**
   * Adapter ships as its own container image and speaks ACP over the container's
   * main-process stdio. Nothing is installed into the workspace; the runtime
   * starts `image` and attaches to PID 1.
   */
  | { kind: "container"; image: string };

/**
 * How to obtain the adapter for a builtin profile id.
 *
 * Every builtin profile is now registry-backed: `Moonrend/acp-registry`
 * publishes an image for each one, so resolution is a straight lookup. A
 * profile the registry does not know is user-defined and supplies its own
 * command, so there is nothing to provision.
 *
 * `pinnedVersion` lets an agent adopt a registry version newer than the one
 * this build shipped, without a redeploy. It only applies to container
 * adapters, and only when the running index still knows the agent: an unknown
 * pin falls through to the registry's own version rather than synthesising an
 * image ref that may not exist.
 */
export function acpAdapterSource(
  profileId: string,
  pinnedVersion?: string | null,
): AcpAdapterSource {
  const agent = acpAgentByProfile(profileId);
  if (agent) {
    // A pin only applies to registry-backed container adapters, and only when
    // the running index still knows the agent — `acpImageAtVersion` returns
    // null for an unknown id, in which case we fall back to the version the
    // index itself advertises instead of synthesising a bogus image ref.
    const pinned = pinnedVersion?.trim();
    const pinnedImage = pinned ? acpImageAtVersion(agent.id, pinned) : null;
    return { kind: "container", image: pinnedImage ?? agent.image };
  }
  // Custom/user-defined profiles supply their own command; nothing to provision.
  return { kind: "image" };
}

/** Registry id for a builtin profile, when it has one. */
export function acpRegistryIdForProfile(profileId: string): string | null {
  return acpAgentByProfile(profileId)?.id ?? null;
}

export function acpProfileIdsWithRegistrySource(): string[] {
  return acpAgents().map((a) => a.profileId);
}
