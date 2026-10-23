// Domain components: how tasks and their metadata look and are edited everywhere.
// Import from here: `import { TaskCard, StatusPicker, useTaskActions } from '@/components/domain'`.
// Catalog: README.md in this folder.

// Task presentation
export { TaskCard, type TaskCardProps } from './TaskCard';
export { TaskRow, type TaskRowProps } from './TaskRow';
export { TaskProgress, TaskProgress as ProgressBar, type TaskProgressProps } from './TaskProgress';

// Task actions (menu, imperative commands, host)
export { TaskActionsMenu, TaskMenuButton, useTaskActions, type TaskActionsMenuProps, type TaskActionsOptions } from './TaskActionsMenu';
export { TaskActionsHost } from './TaskActionsHost';
export { taskActions, type TaskActions, type TaskDeleteOptions, type TaskUpdateOptions } from './taskActions';
export { buildTaskActionItems, type ExtraMenuItems, type TaskActionItemsOptions } from './taskActionItems';

// Icons and labels
export { StatusIcon, type StatusIconProps, type StatusLike } from './StatusIcon';
export { PriorityIcon, priorityColor, priorityLabel, type PriorityIconProps } from './PriorityIcon';
export {
  EpicBadge,
  EpicDot,
  MilestoneBadge,
  PriorityBadge,
  ProjectBadge,
  ProjectDot,
  StatusBadge,
  TaskRef,
  type EpicBadgeProps,
  type MilestoneBadgeProps,
  type PriorityBadgeProps,
  type ProjectBadgeProps,
  type ProjectDotProps,
  type StatusBadgeProps,
  type TaskRefProps,
} from './EntityBadges';
export { TagChip, TagList, type TagChipProps, type TagListProps } from './Tags';
export {
  CommentCountLabel,
  DueDateLabel,
  BlockedLabel,
  DurationLabel,
  EstimateLabel,
  StartDateLabel,
  type BlockedLabelProps,
  type CommentCountLabelProps,
  type DueDateLabelProps,
  type DurationLabelProps,
  type EstimateLabelProps,
  type StartDateLabelProps,
} from './MetaLabels';
export { Pill, type PillProps, type PillSize, type PillTone } from './Pill';
export { UserAvatar, type UserAvatarProps } from './UserAvatar';

// Pickers and editors
export { PropertyButton, type PropertyButtonProps } from './PropertyButton';
export type { DomainPickerProps } from './pickerTypes';
export { StatusPicker, type StatusPickerProps } from './StatusPicker';
export { PriorityPicker, type PriorityPickerProps } from './PriorityPicker';
export { ProjectPicker, type ProjectPickerProps } from './ProjectPicker';
export { MilestonePicker, type MilestonePickerProps } from './MilestonePicker';
export { EpicPicker, type EpicPickerProps } from './EpicPicker';
export { TagPicker, TagPickerList, useCreateTagFromPicker, type TagPickerListProps, type TagPickerProps } from './TagPicker';
export { DateField, DatePicker, type DateFieldProps, type DatePickerProps } from './DateField';
export { EstimateField, EstimatePicker, type EstimateFieldProps, type EstimatePickerProps } from './Estimate';

// Option builders (for UI-kit <Picker multiple> filters)
export {
  PRIORITY_ORDER,
  epicOptions,
  milestoneOptions,
  priorityOptions,
  projectOptions,
  statusOptions,
  tagOptions,
  useEpicOptions,
  useMilestoneOptions,
  usePriorityOptions,
  useProjectOptions,
  useStatusOptions,
  useTagOptions,
  type ProjectOptionsConfig,
  type ScopedOptionsConfig,
} from './options';

// Pure helpers
export {
  DEFAULT_CARD_FIELDS,
  DEFAULT_ROW_FIELDS,
  markdownExcerpt,
  paletteColor,
  resolveFields,
  resolveRowFields,
  tagPatch,
  taskClosedKind,
  taskColor,
  taskIsClosed,
  type CardFieldKey,
  type CardFields,
  type ClosedKind,
  type RowHideKey,
} from './taskDisplay';
export { dueState, quickDates, type DueState, type QuickDate, type QuickDateKey } from './dueDates';
export { ESTIMATE_MAX, ESTIMATE_PRESETS, parseEstimateInput, type EstimateParseResult } from './estimateInput';
export { progressSummary, type ProgressBasis, type ProgressSummary } from './progress';
export { epicGroupLabel, groupEpicsByMilestone, scopeProjectIds, statusFraction, type EpicGroup, type ProjectScope } from './entityGroups';
export { isOpenClick } from './openClick';
export { useSharedToday } from './useSharedToday';
