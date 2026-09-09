/** @file provider-types.ts
 * @purpose Local provider authority contracts at the OpenClaw adapter boundary.
 * @boundary Trusted internal ids in, internal project-agent identity out.
 */

export type ProviderExternalSystem = "openclaw";

export interface ProviderIdentity {
	userId: string;
	projectId: string;
	agentId: string;
}

export interface ProviderAuthorityInput {
	trustedUserId: string;
	externalSystem: ProviderExternalSystem;
	projectKey: string;
	agentKey: string;
}

export interface ProviderMembershipGrantInput extends ProviderAuthorityInput {
	grantor: ProviderIdentity;
}
