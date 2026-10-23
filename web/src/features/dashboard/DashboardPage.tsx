// /dashboard — the signed-in home: a greeting, summary tiles (jump links), open tasks by due
// date, work in progress, recently completed tasks, active projects and recent activity.
// One column on phones; on wide screens task sections take two thirds next to a side column.

import {
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Coffee,
  Link2,
  PartyPopper,
  Plus,
  Sparkles,
  Timer,
  Trophy,
} from 'lucide-react';
import { addDays } from '@shared/dates';
import { formatMinutes } from '@shared/duration';
import type { DashboardDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useDashboard } from '../../api/misc';
import { useTaskQuery } from '../../api/tasks';
import { useSpace, useSpacePath } from '../../app/space';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { ButtonLink, Card, EmptyState, ErrorState, Skeleton } from '../../components/ui';
import { formatDate, formatDateLong, pluralize } from '../../lib/format';
import { useDocumentTitle, useToday } from '../../lib/hooks';
import { ActivityCard, ProjectsCard, StatTile, TaskSection, TaskSectionSkeleton } from './DashboardCards';
import { dashboardSectionQuery, dueTomorrowHint, greetingFor } from './dashboardModel';

export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const today = useToday();
  const { user, projects, settings } = useLookups();
  const dashboard = useDashboard(today, settings.weekStartsOn);

  const header = (
    <PageHeader title={`${greetingFor(new Date().getHours())}, ${user.displayName}`} subtitle={formatDateLong(today)} />
  );

  let content;
  if (projects.length === 0) content = <Welcome />;
  else if (dashboard.data) content = <DashboardContent data={dashboard.data} today={today} />;
  else if (dashboard.isError) content = <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />;
  else content = <DashboardSkeleton />;

  return (
    <Page width="wide" header={header}>
      {content}
    </Page>
  );
}

/**
 * Open tasks whose blockers push their due date later (task dependencies): only while there are any. The
 * dashboard counts them; the list comes from the slipped filter.
 */
function SlippedSection({ total, today }: { total: number; today: string }) {
  const query = useTaskQuery(dashboardSectionQuery('slipped', today, 50));
  return (
    <TaskSection
      id="slipped"
      section="slipped"
      title="Slipped"
      icon={<Link2 />}
      tone="warning"
      tasks={query.data?.tasks ?? []}
      total={total}
      today={today}
      empty={{ icon: <Link2 />, text: query.isLoading ? 'Loading…' : 'Nothing has slipped.' }}
    />
  );
}

function DashboardContent({ data, today }: { data: DashboardDTO; today: string }) {
  const sp = useSpacePath();
  const { counts } = data;
  const oldestOverdue = data.overdue[0]?.dueDate ?? null;
  const tasksUnit = (n: number) => (n === 1 ? 'task' : 'tasks');

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <nav aria-label="Summary">
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
          <li>
            <StatTile
              label="Overdue"
              value={String(counts.overdue)}
              unit={tasksUnit(counts.overdue)}
              hint={oldestOverdue ? `Oldest from ${formatDate(oldestOverdue, today)}` : 'All caught up'}
              icon={<CircleAlert />}
              tone="danger"
              emphasize={counts.overdue > 0}
              target={{ section: 'overdue' }}
            />
          </li>
          <li>
            <StatTile
              label="Due today"
              value={String(counts.dueToday)}
              unit={tasksUnit(counts.dueToday)}
              hint={dueTomorrowHint(data.dueSoon, counts.dueSoon, addDays(today, 1))}
              icon={<CalendarClock />}
              tone="warning"
              emphasize={counts.dueToday > 0}
              target={{ section: 'due-today' }}
            />
          </li>
          <li>
            <StatTile
              label="In progress"
              value={String(counts.inProgress)}
              unit={tasksUnit(counts.inProgress)}
              hint={data.inProgressProjects > 0 ? `Across ${pluralize(data.inProgressProjects, 'project')}` : 'Nothing started'}
              icon={<CircleDot />}
              tone="accent"
              target={{ section: 'in-progress' }}
            />
          </li>
          <li>
            <StatTile
              label="Logged this week"
              value={formatMinutes(data.worklog.weekMinutes)}
              hint={`Today ${formatMinutes(data.worklog.todayMinutes)}`}
              icon={<Timer />}
              tone="success"
              target={{ to: sp('/worklog') }}
            />
          </li>
        </ul>
      </nav>

      {/* Explicit grid-cols-1 (minmax(0, 1fr)) on phones: an implicit `auto` track would grow to
          a card's min-content width (e.g. a long nowrap project name) and widen the page. */}
      <div className="grid grid-cols-1 items-start gap-5 md:gap-6 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-5 md:gap-6 xl:col-span-2">
          <TaskSection
            id="overdue"
            section="overdue"
            title="Overdue"
            icon={<CircleAlert />}
            tone="danger"
            tasks={data.overdue}
            total={counts.overdue}
            today={today}
            empty={{ icon: <PartyPopper />, text: 'Nothing overdue — you’re all caught up.' }}
          />
          {data.slipped > 0 && <SlippedSection total={data.slipped} today={today} />}
          <TaskSection
            id="due-today"
            section="dueToday"
            title="Due today"
            icon={<CalendarClock />}
            tone="warning"
            tasks={data.dueToday}
            total={counts.dueToday}
            today={today}
            fields={{ dueDate: false }}
            empty={{ icon: <Coffee />, text: 'Nothing due today. A good day to get ahead.' }}
          />
          <TaskSection
            id="due-soon"
            section="dueSoon"
            title="Due in the next 7 days"
            icon={<CalendarDays />}
            tone="accent"
            tasks={data.dueSoon}
            total={counts.dueSoon}
            today={today}
            empty={{ icon: <CalendarCheck />, text: 'The week ahead is clear.' }}
          />
          <TaskSection
            id="in-progress"
            section="inProgress"
            title="In progress"
            icon={<CircleDot />}
            tone="accent"
            tasks={data.inProgress}
            total={counts.inProgress}
            today={today}
            empty={{ icon: <Sparkles />, text: 'Nothing in progress. Pick a task and get going.' }}
          />
          <TaskSection
            id="recently-completed"
            section="recentlyClosed"
            title="Recently completed"
            icon={<CircleCheck />}
            tone="success"
            tasks={data.recentlyClosed}
            total={counts.recentlyClosed}
            today={today}
            empty={{ icon: <Trophy />, text: 'Tasks you finish this week will gather here.' }}
          />
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-5 md:grid-cols-2 md:gap-6 xl:grid-cols-1">
          <ProjectsCard today={today} />
          <ActivityCard items={data.recentActivity} />
        </div>
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5 md:gap-6" role="status">
      <span className="sr-only">Loading dashboard</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} padding="sm" className="flex flex-col gap-2 md:p-4">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-7 w-12" />
            <Skeleton className="h-3 w-24" />
          </Card>
        ))}
      </div>
      <div className="grid items-start gap-5 md:gap-6 xl:grid-cols-3">
        <div className="flex flex-col gap-5 md:gap-6 xl:col-span-2">
          <TaskSectionSkeleton rows={3} />
          <TaskSectionSkeleton rows={2} />
        </div>
        <TaskSectionSkeleton rows={4} />
      </div>
    </div>
  );
}

function Welcome() {
  const sp = useSpacePath();
  const { write } = useSpace().permissions;
  return (
    <Card padding="lg">
      <EmptyState
        icon={<Sparkles />}
        title="Welcome to Lyren Plan"
        body={
          write
            ? 'Create your first project to start planning. Overdue and upcoming tasks, work in progress and recent activity will show up here.'
            : 'This space has no projects yet. Overdue and upcoming tasks, work in progress and recent activity will show up here.'
        }
        action={
          write && (
            <ButtonLink to={sp('/projects')} variant="primary" icon={<Plus />}>
              Create a project
            </ButtonLink>
          )
        }
      />
    </Card>
  );
}
