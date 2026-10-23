// Test fixtures for domain helper tests (not shipped: only imported by *.test.ts).

import type { EpicDTO, MilestoneDTO, ProjectDTO, StatusDTO, TaskDTO } from '@shared/types';

const TS = '2026-10-01T10:00:00.000Z';

export function status(id: number, category: StatusDTO['category'], position = id, color = '#3b82f6'): StatusDTO {
  return { id, name: `S${id}`, category, color, position, taskCount: 0 };
}

export function project(id: number, key: string, extra: Partial<ProjectDTO> = {}): ProjectDTO {
  return {
    id,
    key,
    name: `Project ${key}`,
    description: '',
    color: '#6366f1',
    status: 'active',
    position: id,
    createdAt: TS,
    updatedAt: TS,
    stats: {
      tasksTotal: 0,
      tasksOpen: 0,
      tasksClosed: 0,
      tasksOverdue: 0,
      milestonesTotal: 0,
      milestonesCompleted: 0,
      epicsTotal: 0,
      epicsDone: 0,
    },
    ...extra,
  };
}

export function milestone(id: number, projectId: number, position = id, extra: Partial<MilestoneDTO> = {}): MilestoneDTO {
  return {
    id,
    projectId,
    name: `M${id}`,
    description: '',
    status: 'active',
    startDate: null,
    dueDate: null,
    position,
    completedAt: null,
    createdAt: TS,
    updatedAt: TS,
    stats: { tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0, epicsTotal: 0, epicsDone: 0 },
    ...extra,
  };
}

export function epic(id: number, projectId: number, milestoneId: number | null, position = id, extra: Partial<EpicDTO> = {}): EpicDTO {
  return {
    id,
    projectId,
    milestoneId,
    name: `E${id}`,
    description: '',
    color: '#8b5cf6',
    status: 'open',
    startDate: null,
    dueDate: null,
    position,
    completedAt: null,
    createdAt: TS,
    updatedAt: TS,
    stats: { tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0 },
    ...extra,
  };
}

export function task(extra: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id: 1,
    projectId: 1,
    number: 1,
    ref: 'WEB-1',
    epicId: null,
    milestoneId: null,
    statusId: 1,
    priority: 0,
    title: 'Task',
    description: '',
    startDate: null,
    dueDate: null,
    estimate: null,
    rank: 'a0',
    completedAt: null,
    archivedAt: null,
    createdBy: 1,
    createdAt: TS,
    updatedAt: TS,
    tags: [],
    commentCount: 0,
    worklogMinutes: 0,
    blockedBy: [],
    blocks: [],
    adjustedStartDate: extra.startDate ?? null,
    adjustedDueDate: extra.dueDate ?? null,
    slipDays: 0,
    ...extra,
  };
}

function groupBy<T>(items: T[], key: (t: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return m;
}

/** A lookups-like object for the given entities (same shape as api/bootstrap Lookups' maps). */
export function lookups(entities: { statuses?: StatusDTO[]; projects?: ProjectDTO[]; milestones?: MilestoneDTO[]; epics?: EpicDTO[] }) {
  const statuses = entities.statuses ?? [];
  const projects = entities.projects ?? [];
  const milestones = entities.milestones ?? [];
  const epics = entities.epics ?? [];
  return {
    statuses,
    projects,
    milestones,
    epics,
    statusById: new Map(statuses.map((s) => [s.id, s])),
    projectById: new Map(projects.map((p) => [p.id, p])),
    milestoneById: new Map(milestones.map((m) => [m.id, m])),
    epicById: new Map(epics.map((e) => [e.id, e])),
    milestonesByProject: groupBy(milestones, (m) => m.projectId),
    epicsByProject: groupBy(epics, (e) => e.projectId),
    settings: { weekStartsOn: 1 as const },
  };
}
