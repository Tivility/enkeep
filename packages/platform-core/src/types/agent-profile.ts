export type LifecycleStatus = 'active' | 'archived' | 'deleted';

export type AgentProfileSection = 'IDENTITY' | 'SOUL' | 'AGENTS' | 'TOOLS';

export interface AgentProfileSections {
  identity: string;
  soul: string;
  agents: string;
  tools: string;
}

export type AgentProfilePromptMode = 'append';

export interface AgentProfile {
  id: string;
  userId: string; // Tenant/Owner ID
  name: string;
  description?: string | null;
  status: LifecycleStatus;
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileSnapshot {
  id: string;
  userId: string;
  profileId: string;
  version: number;
  promptMode: AgentProfilePromptMode; // strictly 'append'
  promptHash: string; // mandatory string (not optional/null)
  identity: string;
  soul: string;
  agents: string;
  tools: string;
  changeSummary?: string | null;
  createdAt: string;
}

export interface PublicAgentProfileSnapshot {
  version: number;
  identity: string;
  soul: string;
  agents: string;
  tools: string;
  changeSummary?: string | null;
  createdAt: string;
}

export function toPublicAgentProfileSnapshot(snapshot: AgentProfileSnapshot): PublicAgentProfileSnapshot {
  return {
    version: snapshot.version,
    identity: snapshot.identity,
    soul: snapshot.soul,
    agents: snapshot.agents,
    tools: snapshot.tools,
    changeSummary: snapshot.changeSummary ?? null,
    createdAt: snapshot.createdAt,
  };
}

export interface SafeBoundProfileSummary {
  id: string;
  name: string;
  version: number;
}

export interface SpaceProfileBindingResult {
  spaceId: string;
  profile: SafeBoundProfileSummary | null;
}

export interface AgentProfileWithSnapshot extends AgentProfile {
  snapshot?: AgentProfileSnapshot | null;
}

export interface CreateAgentProfileInput {
  id?: string;
  userId: string;
  name: string;
  description?: string | null;
  promptMode?: AgentProfilePromptMode; // Defaults to 'append'
  identity?: string;
  soul?: string;
  agents?: string;
  tools?: string;
  changeSummary?: string | null;
}

export interface UpdateAgentProfileInput {
  name?: string;
  description?: string | null;
  status?: LifecycleStatus;
}

export interface CreateAgentProfileVersionInput {
  promptMode?: AgentProfilePromptMode; // Must be 'append' if specified
  identity?: string;
  soul?: string;
  agents?: string;
  tools?: string;
  changeSummary?: string | null;
}

export interface RollbackAgentProfileVersionInput {
  targetVersion: number;
  changeSummary?: string | null;
  actorUserId?: string | null;
}

export interface RollbackAgentProfileResult extends PublicAgentProfileSnapshot {
  newVersion: number;
}

export interface EffectiveAgentProfile {
  source: 'route' | 'space' | 'none';
  profileId?: string;
  snapshotId?: string;
  version?: number;
  promptMode?: AgentProfilePromptMode;
  identity: string;
  soul: string;
  agents: string;
  tools: string;
  composedPrompt: string;
}

/**
 * Composes the 4-section prompt in append-only mode.
 * Sections are formatted as distinct markdown blocks that append to the base system prompt.
 * Under no circumstances does this replace the official DSH system prompt.
 */
export function composeAgentProfilePrompt(sections: Partial<AgentProfileSections>): string {
  const parts: string[] = [];

  if (sections.identity && sections.identity.trim()) {
    parts.push(`### AGENT IDENTITY\n${sections.identity.trim()}`);
  }
  if (sections.soul && sections.soul.trim()) {
    parts.push(`### AGENT SOUL\n${sections.soul.trim()}`);
  }
  if (sections.agents && sections.agents.trim()) {
    parts.push(`### SUB-AGENTS & DELEGATION\n${sections.agents.trim()}`);
  }
  if (sections.tools && sections.tools.trim()) {
    parts.push(`### TOOLS GUIDELINES\n${sections.tools.trim()}`);
  }

  return parts.join('\n\n');
}
