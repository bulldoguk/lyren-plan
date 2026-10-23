// /projects/:projectId — resolves the project, renders its header (color, name, key, status,
// description toggle, actions menu by the viewer's role, design §12.9) with the Overview / Board /
// Tasks / Activity tabs, and the child route. Milestone and epic pages render their own header (breadcrumb Project › …), so
// for them this layout only provides the project through the outlet context.

import { Archive, ArchiveRestore, CalendarSync, FolderX, Info, Milestone as MilestoneIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { PROJECT_STATUSES } from '@shared/constants';
import type { ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useSpace, useSpaceId, useSpacePath } from '../../app/space';
import { FullBleedPage, Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { isBoolean, usePersistentState } from '../../components/layout/usePersistentState';
import { ButtonLink, EmptyState, IconButton, Markdown, normalizeMenuItems, toast } from '../../components/ui';
import { useDocumentTitle } from '../../lib/hooks';
import { projectUrl } from '../../lib/taskLinks';
import { RebaselineDialog } from '../tasks/RebaselineDialog';
import { DeleteProjectDialog } from './DeleteDialogs';
import { LifecycleBadge, lifecycleMeta } from './LifecycleStatus';
import { parseRouteId, type ProjectOutletContext } from './projectContext';
import { ProjectFormDialog } from './ProjectFormDialog';
import { useHierarchyDialogs } from './useHierarchyDialogs';
import { useSaveProject } from './useHierarchyMutations';

type Section = 'overview' | 'board' | 'tasks' | 'activity' | 'entity';

const SECTION_TITLES: Record<Exclude<Section, 'overview' | 'entity'>, string> = {
  board: 'Board',
  tasks: 'Tasks',
  activity: 'Activity',
};

function sectionOf(pathname: string, base: string): Section {
  const first = pathname.slice(base.length).replace(/^\/+/, '').split('/')[0] ?? '';
  if (first === 'board' || first === 'tasks' || first === 'activity') return first;
  if (first === 'milestones' || first === 'epics') return 'entity';
  return 'overview';
}

export default function ProjectLayout() {
  const sp = useSpacePath();
  const { projectId: param = '' } = useParams();
  const id = parseRouteId(param);
  const { projectById } = useLookups();
  const project = id === null ? undefined : projectById.get(id);
  const { pathname } = useLocation();
  const section = sectionOf(pathname, sp(`/projects/${param}`));
  // Set while this page deletes the project, so its disappearance doesn't flash "not found".
  const deletingRef = useRef<number | null>(null);

  const title = !project
    ? deletingRef.current !== null
      ? null
      : 'Project not found'
    : section === 'entity'
      ? null // milestone / epic pages set their own title
      : section === 'overview'
        ? project.name
        : `${SECTION_TITLES[section]} · ${project.name}`;
  useDocumentTitle(title);

  if (!project) {
    if (deletingRef.current !== null) return null;
    return <ProjectNotFound />;
  }
  const context: ProjectOutletContext = { project };
  if (section === 'entity') return <Outlet context={context} />;
  return (
    <ProjectChrome project={project} section={section} deletingRef={deletingRef}>
      <Outlet context={context} />
    </ProjectChrome>
  );
}

function ProjectNotFound() {
  const sp = useSpacePath();
  return (
    <Page header={<PageHeader title="Project not found" backTo={sp('/projects')} breadcrumbs={[{ label: 'Projects', to: sp('/projects') }]} />}>
      <EmptyState
        icon={<FolderX />}
        title="This project doesn’t exist"
        body="It may have been deleted, or the link is wrong."
        action={<ButtonLink to={sp('/projects')}>All projects</ButtonLink>}
      />
    </Page>
  );
}

function ProjectChrome({
  project,
  section,
  deletingRef,
  children,
}: {
  project: ProjectDTO;
  section: Exclude<Section, 'entity'>;
  deletingRef: RefObject<number | null>;
  children: ReactNode;
}) {
  const sp = useSpacePath();
  const sid = useSpaceId();
  const { write, deleteProjects } = useSpace().permissions;
  const navigate = useNavigate();
  const save = useSaveProject();
  const hierarchy = useHierarchyDialogs(project.id);
  const [editOpen, setEditOpen] = useState(false);
  const [rebaselineOpen, setRebaselineOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectDTO | null>(null);
  const [showDescription, setShowDescription] = usePersistentState('lyren.project.showDescription', false, isBoolean);
  const base = projectUrl(sid, project.id);
  const hasDescription = project.description.trim().length > 0;
  // The overview shows (and edits) the description itself.
  const descriptionToggle = section !== 'overview' && hasDescription;

  const setStatus = async (status: ProjectDTO['status']) => {
    const previous = project.status;
    const saved = await save(project, { status });
    if (!saved) return;
    toast.success(`${project.name}: ${lifecycleMeta('project', status).label}`, {
      action: { label: 'Undo', onClick: () => void save(project, { status: previous }) },
    });
  };

  const menu = normalizeMenuItems([
    write && { label: 'Edit project…', icon: <Pencil />, onSelect: () => setEditOpen(true) },
    write && {
      label: 'Status',
      icon: (() => {
        const Icon = lifecycleMeta('project', project.status).icon;
        return <Icon />;
      })(),
      hint: lifecycleMeta('project', project.status).label,
      items: PROJECT_STATUSES.map((status) => {
        const Icon = lifecycleMeta('project', status).icon;
        return {
          label: lifecycleMeta('project', status).label,
          icon: <Icon />,
          checked: project.status === status,
          onSelect: () => status !== project.status && void setStatus(status),
        };
      }),
    },
    write &&
      (project.status === 'archived'
        ? { label: 'Unarchive project', icon: <ArchiveRestore />, onSelect: () => void setStatus('active') }
        : { label: 'Archive project', icon: <Archive />, onSelect: () => void setStatus('archived') }),
    { separator: true },
    write && { label: 'New milestone…', icon: <MilestoneIcon />, onSelect: hierarchy.newMilestone },
    write && { label: 'New epic…', icon: <Plus />, onSelect: () => hierarchy.newEpic(null) },
    write && { label: 'Rebaseline slipped tasks…', icon: <CalendarSync />, onSelect: () => setRebaselineOpen(true) },
    { separator: true },
    deleteProjects && { label: 'Delete project…', icon: <Trash2 />, danger: true, onSelect: () => setDeleteTarget(project) },
  ]);

  const header = (
    <PageHeader
      title={project.name}
      icon={<span aria-hidden className="size-4 rounded-[5px]" style={{ backgroundColor: project.color }} />}
      subtitle={
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-mono font-medium tracking-wide">{project.key}</span>
          <LifecycleBadge kind="project" status={project.status} />
        </span>
      }
      backTo={sp('/projects')}
      breadcrumbs={[{ label: 'Projects', to: sp('/projects') }]}
      actions={
        descriptionToggle ? (
          <IconButton
            aria-label={showDescription ? 'Hide description' : 'Show description'}
            icon={<Info />}
            pressed={showDescription}
            onClick={() => setShowDescription((v) => !v)}
            aria-expanded={showDescription}
            aria-controls="project-description"
          />
        ) : undefined
      }
      menu={menu}
      tabs={[
        { to: base, label: 'Overview', end: true },
        { to: `${base}/board`, label: 'Board' },
        { to: `${base}/tasks`, label: 'Tasks', count: project.stats.tasksOpen },
        { to: `${base}/activity`, label: 'Activity' },
      ]}
    >
      {descriptionToggle && showDescription && (
        <div
          id="project-description"
          className="mb-2 max-h-[40dvh] overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-sm md:max-h-64"
        >
          <Markdown source={project.description} />
        </div>
      )}
    </PageHeader>
  );

  const dialogs = (
    <>
      {hierarchy.dialogs}
      <ProjectFormDialog open={editOpen} onClose={() => setEditOpen(false)} project={project} />
      <RebaselineDialog
        open={rebaselineOpen}
        onClose={() => setRebaselineOpen(false)}
        scope={{ projectId: project.id }}
        scopeLabel={project.name}
      />
      <DeleteProjectDialog
        project={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleting={() => (deletingRef.current = project.id)}
        onFailed={() => (deletingRef.current = null)}
        onDeleted={() => navigate(sp('/projects'), { replace: true })}
      />
    </>
  );

  if (section === 'board') {
    // Boards are fixed-height (SPEC §9): the project header + tabs and ProjectBoardPage (a plain
    // flex column, not a nested FullBleedPage) fill the viewport. overflow-y-auto is a fallback
    // scroller for the content area should the board ever be taller than the remaining space.
    return (
      <FullBleedPage header={header} className="overflow-y-auto">
        {children}
        {dialogs}
      </FullBleedPage>
    );
  }
  return (
    <Page width="wide" header={header}>
      {children}
      {dialogs}
    </Page>
  );
}
