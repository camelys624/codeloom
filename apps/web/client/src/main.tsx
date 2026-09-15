import { StrictMode, forwardRef, useEffect, useRef, useState } from 'react';
import type {
  ComponentPropsWithoutRef,
  DragEvent,
  ReactElement,
  ReactNode,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Command } from 'cmdk';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  Command as CommandIcon,
  Download,
  ExternalLink,
  GitBranch,
  LayoutGrid,
  List,
  LogOut,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Sun,
  X,
} from 'lucide-react';
import {
  Link,
  NavLink,
  Outlet,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  BrowserServerMessageSchema,
  RunEventSchema,
  TranscriptChunkSchema,
  type AgentProfile,
  type ApprovalRequest,
  type RunEvent,
  type Runner,
  type Task,
  type TaskStatus,
  type TranscriptChunk,
} from '@agent-workspace/contracts';
import { AppSelect } from './components/ui/select.js';
import { api, ApiError, type RunSnapshot } from './lib/api.js';
import { AttemptStream } from './lib/stream.js';
import { buildTimeline, type TimelineEntry } from './lib/timeline.js';
import {
  countTranscriptFrames,
  filterTranscriptChunks,
  transcriptToText,
} from './lib/transcript.js';
import {
  canMoveTask,
  sortTasks,
  TASK_COLUMNS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITIES,
  TASK_STATUS_LABELS,
  taskMatchesFilters,
  type TaskPriority,
} from './lib/tasks.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'aria-label'> & {
    label: string;
    children: ReactElement;
  }
>(function IconButton(
  { label, children, className = '', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`icon-button${className ? ` ${className}` : ''}`}
      aria-label={label}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
});

function AppTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content" sideOffset={6}>
            {label}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog-content${className ? ` ${className}` : ''}`}
          onOpenAutoFocus={(event) => {
            if (className === 'task-dialog') {
              event.preventDefault();
              const content = event.currentTarget as HTMLElement;
              window.requestAnimationFrame(() => {
                const firstField = content.querySelector<HTMLElement>(
                  'input, textarea, [role="combobox"]',
                );
                firstField?.focus();
              });
            }
          }}
        >
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="dialog-description">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton label="关闭">
                <X size={17} strokeWidth={1.8} />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AppDropdownMenu({
  trigger,
  children,
  align = 'end',
}: {
  trigger: ReactElement;
  children: ReactNode;
  align?: DropdownMenu.DropdownMenuContentProps['align'];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content"
          align={align}
          sideOffset={8}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : '请求失败';
  return <div className="notice">{message}</div>;
}

function AuthPage() {
  const client = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      mode === 'login'
        ? api.login(email, password)
        : api.register(email, password, displayName),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <main className="auth">
      <section className="card">
        <h1 className="title">Codeloom</h1>
        <p className="muted">登录后管理任务、Runner 和多轮 Agent 执行。</p>
        {mutation.error && <ErrorNotice error={mutation.error} />}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          {mode === 'register' && (
            <label>
              显示名称
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
          )}
          <label>
            邮箱
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button disabled={mutation.isPending}>
            {mutation.isPending
              ? '提交中…'
              : mode === 'login'
                ? '登录'
                : '创建首个用户'}
          </button>
        </form>
        <button
          className="secondary"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            mutation.reset();
          }}
        >
          {mode === 'login' ? '首次启动？创建管理员' : '已有账户？返回登录'}
        </button>
      </section>
    </main>
  );
}

function Layout() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['me'] });
    },
  });
  useEffect(() => {
    const savedTheme = window.localStorage.getItem('codeloom-theme');
    if (savedTheme === 'dark') setTheme('dark');
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('codeloom-theme', theme);
  }, [theme]);
  return (
    <div className={`shell${sidebarCollapsed ? ' shell-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <Link className="brand" to="/">
            <span className="brand-mark">C</span>
            {!sidebarCollapsed && <span>Codeloom</span>}
          </Link>
          <AppTooltip label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}>
            <IconButton
              className="sidebar-toggle"
              label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen size={16} strokeWidth={1.8} />
              ) : (
                <PanelLeftClose size={16} strokeWidth={1.8} />
              )}
            </IconButton>
          </AppTooltip>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          <NavLink className="nav-item" to="/" end>
            <LayoutGrid className="nav-icon" size={16} strokeWidth={1.8} />
            {!sidebarCollapsed && <span>Tasks</span>}
          </NavLink>
          <NavLink className="nav-item" to="/runners">
            <GitBranch className="nav-icon" size={16} strokeWidth={1.8} />
            {!sidebarCollapsed && <span>Runners</span>}
          </NavLink>
        </nav>
        {!sidebarCollapsed && (
          <div className="sidebar-section">
            <span className="sidebar-label">Workspace</span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="workspace-switcher" type="button">
                  Personal workspace <ChevronDown size={14} strokeWidth={1.8} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="dropdown-content"
                  align="start"
                  sideOffset={8}
                >
                  <DropdownMenu.Label className="dropdown-label">
                    Workspace
                  </DropdownMenu.Label>
                  <DropdownMenu.Item className="dropdown-item">
                    Personal workspace
                    <Check size={15} strokeWidth={2} />
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        )}
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            onClick={() => setPaletteOpen(true)}
            type="button"
          >
            <CommandIcon className="nav-icon" size={16} strokeWidth={1.8} />
            {!sidebarCollapsed && (
              <>
                <span>Command menu</span>
                <kbd>⌘K</kbd>
              </>
            )}
          </button>
          <button
            className="nav-item"
            onClick={() =>
              setTheme((value) => (value === 'light' ? 'dark' : 'light'))
            }
            type="button"
          >
            {theme === 'light' ? (
              <Moon className="nav-icon" size={16} strokeWidth={1.8} />
            ) : (
              <Sun className="nav-icon" size={16} strokeWidth={1.8} />
            )}
            {!sidebarCollapsed && (
              <span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
            )}
          </button>
          {!sidebarCollapsed && (
            <AppDropdownMenu
              trigger={
                <button className="profile-button" type="button">
                  <span className="avatar">R</span>
                  <span className="profile-copy">
                    <strong>Robbie</strong>
                    <small>Personal</small>
                  </span>
                  <MoreHorizontal className="profile-more" size={17} />
                </button>
              }
            >
              <DropdownMenu.Item
                className="dropdown-item dropdown-item-danger"
                onSelect={() => logout.mutate()}
                disabled={logout.isPending}
              >
                <LogOut size={15} strokeWidth={1.8} />
                Log out
              </DropdownMenu.Item>
            </AppDropdownMenu>
          )}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span className="muted">Workspace</span>
            <span>/</span>
            <strong>Tasks</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="search-trigger"
              aria-label="打开命令菜单"
              onClick={() => setPaletteOpen(true)}
              type="button"
            >
              <Search size={15} strokeWidth={1.8} /> Search <kbd>⌘K</kbd>
            </button>
            <AppTooltip label="通知">
              <IconButton label="通知" disabled>
                <Bell size={17} strokeWidth={1.8} />
              </IconButton>
            </AppTooltip>
            <AppDropdownMenu
              trigger={
                <button
                  className="avatar avatar-small"
                  aria-label="用户菜单"
                  type="button"
                >
                  R
                </button>
              }
            >
              <DropdownMenu.Item
                className="dropdown-item dropdown-item-danger"
                onSelect={() => logout.mutate()}
                disabled={logout.isPending}
              >
                <LogOut size={15} strokeWidth={1.8} />
                Log out
              </DropdownMenu.Item>
            </AppDropdownMenu>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={(path) => {
          navigate(path);
          setPaletteOpen(false);
        }}
      />
    </div>
  );
}

function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
}) {
  const commands = [
    { label: 'Open tasks', detail: 'View the task board', path: '/' },
    {
      label: 'Open runners',
      detail: 'Manage runners and profiles',
      path: '/runners',
    },
  ];
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command menu"
      overlayClassName="command-overlay"
      contentClassName="command-palette"
      loop
    >
      <Command.Input placeholder="Search commands…" />
      <Command.List>
        <Command.Empty className="empty-state">
          No commands found.
        </Command.Empty>
        <Command.Group heading="Navigation">
          {commands.map((command) => (
            <Command.Item
              className="command-item"
              key={command.path}
              value={`${command.label} ${command.detail}`}
              onSelect={() => onNavigate(command.path)}
            >
              <ExternalLink
                size={15}
                strokeWidth={1.8}
                className="command-symbol"
              />
              <span>
                <strong>{command.label}</strong>
                <small>{command.detail}</small>
              </span>
              <span className="muted">Enter</span>
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
      <footer>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </footer>
    </Command.Dialog>
  );
}

function TasksPage() {
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks });
  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: api.repositories,
  });
  const client = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [query, setQuery] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | 'all'>(
    'all',
  );
  const [view, setView] = useState<'board' | 'list'>('board');
  const [createOpen, setCreateOpen] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.createTask({
        title,
        description,
        priority: priority || undefined,
        repositoryId: repositoryId || null,
      }),
    onSuccess: () => {
      setTitle('');
      setDescription('');
      setPriority('');
      setRepositoryId('');
      setCreateOpen(false);
      void client.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const move = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: TaskStatus }) =>
      api.updateTask(task.id, { revision: task.revision, status }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const updatingTaskId = move.isPending ? move.variables?.task.id : undefined;
  const handleMove = (task: Task, status: TaskStatus) => {
    if (move.isPending || task.status === status || !canMoveTask(task, status))
      return;
    move.mutate({ task, status });
  };
  if (tasks.isPending || repositories.isPending) return <p>加载任务…</p>;
  if (tasks.error || repositories.error)
    return <ErrorNotice error={tasks.error ?? repositories.error} />;
  const visibleTasks = sortTasks(
    tasks.data.filter((task) =>
      taskMatchesFilters(task, query, priorityFilter),
    ),
  );
  return (
    <div className="tasks-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Workspace</span>
          <h1 className="page-title">Tasks</h1>
          <p className="page-subtitle">A focused space for your team's work.</p>
        </div>
        <button
          className="primary-action"
          onClick={() => setCreateOpen(true)}
          type="button"
        >
          <Plus size={15} strokeWidth={2} /> New task
        </button>
      </section>
      <section className="board-toolbar">
        <div className="toolbar-left">
          <label className="board-search">
            <Search size={15} strokeWidth={1.8} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter tasks…"
            />
          </label>
          <div
            className="filter-chips"
            role="group"
            aria-label="Priority filter"
          >
            <button
              className={`filter-chip${priorityFilter === 'all' ? ' selected' : ''}`}
              onClick={() => setPriorityFilter('all')}
              type="button"
            >
              All tasks <span>{tasks.data.length}</span>
            </button>
            {TASK_PRIORITIES.map((value) => (
              <button
                className={`filter-chip priority-${value}${priorityFilter === value ? ' selected' : ''}`}
                key={value}
                onClick={() => setPriorityFilter(value)}
                type="button"
              >
                <span className="priority-dot" />
                {TASK_PRIORITY_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
        <ToggleGroup.Root
          className="view-toggle"
          type="single"
          value={view}
          onValueChange={(value) => {
            if (value) setView(value as 'board' | 'list');
          }}
          aria-label="Task view"
        >
          <ToggleGroup.Item
            className="view-toggle-item"
            value="board"
            aria-label="Board view"
          >
            <LayoutGrid size={14} strokeWidth={1.8} /> Board
          </ToggleGroup.Item>
          <ToggleGroup.Item
            className="view-toggle-item"
            value="list"
            aria-label="List view"
          >
            <List size={14} strokeWidth={1.8} /> List
          </ToggleGroup.Item>
        </ToggleGroup.Root>
      </section>
      {move.error && <ErrorNotice error={move.error} />}
      {view === 'board' ? (
        <TaskBoard
          tasks={visibleTasks}
          updatingTaskId={updatingTaskId}
          onAddTask={() => setCreateOpen(true)}
          onMove={handleMove}
        />
      ) : (
        <TaskList
          tasks={visibleTasks}
          updatingTaskId={updatingTaskId}
          onMove={handleMove}
        />
      )}
      {createOpen && (
        <CreateTaskDialog
          open={createOpen}
          title={title}
          description={description}
          priority={priority}
          repositoryId={repositoryId}
          repositories={repositories.data}
          pending={create.isPending}
          error={create.error}
          onTitle={setTitle}
          onDescription={setDescription}
          onPriority={setPriority}
          onRepository={setRepositoryId}
          onClose={() => setCreateOpen(false)}
          onSubmit={() => create.mutate()}
        />
      )}
    </div>
  );
}

function TaskBoard({
  tasks,
  onMove,
  onAddTask,
  updatingTaskId,
}: {
  tasks: Task[];
  onMove: (task: Task, status: TaskStatus) => void;
  onAddTask?: () => void;
  updatingTaskId?: string;
}) {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropStatus, setDropStatus] = useState<TaskStatus | null>(null);
  const draggedTask = draggedTaskId
    ? tasks.find((task) => task.id === draggedTaskId)
    : undefined;
  const clearDrag = () => {
    setDraggedTaskId(null);
    setDropStatus(null);
  };
  const handleDrop = (status: TaskStatus, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData('text/plain') || draggedTaskId;
    const task = taskId ? tasks.find((item) => item.id === taskId) : undefined;
    clearDrag();
    if (task && task.status !== status && canMoveTask(task, status))
      onMove(task, status);
  };
  return (
    <div className="task-board">
      {TASK_COLUMNS.map((status) => {
        const columnTasks = tasks.filter((task) => task.status === status);
        const canDrop =
          draggedTask !== undefined &&
          draggedTask.status !== status &&
          canMoveTask(draggedTask, status);
        const dropClass =
          dropStatus === status
            ? canDrop
              ? ' is-drop-target'
              : ' is-drop-invalid'
            : '';
        return (
          <section
            aria-label={`${TASK_STATUS_LABELS[status]} tasks`}
            className={`task-column${dropClass}`}
            key={status}
            onDragLeave={(event) => {
              const relatedTarget = event.relatedTarget as Node | null;
              if (
                !relatedTarget ||
                !event.currentTarget.contains(relatedTarget)
              )
                setDropStatus(null);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = canDrop ? 'move' : 'none';
              setDropStatus(status);
            }}
            onDrop={(event) => handleDrop(status, event)}
          >
            <header>
              <span className={`column-dot column-${status}`} />
              <h2>{TASK_STATUS_LABELS[status]}</h2>
              <span className="column-count">{columnTasks.length}</span>
              <AppTooltip label={`${TASK_STATUS_LABELS[status]} menu`}>
                <IconButton
                  label={`${TASK_STATUS_LABELS[status]} menu`}
                  disabled
                >
                  <MoreHorizontal size={16} strokeWidth={1.8} />
                </IconButton>
              </AppTooltip>
            </header>
            <div className="task-column-body">
              {columnTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isDragging={task.id === draggedTaskId}
                  isUpdating={task.id === updatingTaskId}
                  onDragEnd={clearDrag}
                  onDragStart={(event) => {
                    setDraggedTaskId(task.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', task.id);
                  }}
                  onMove={onMove}
                />
              ))}
              {columnTasks.length === 0 && (
                <div className="empty-column">No tasks</div>
              )}
            </div>
            <button
              className="add-task-inline"
              onClick={onAddTask}
              type="button"
            >
              <Plus size={14} strokeWidth={1.8} /> Add task
            </button>
          </section>
        );
      })}
    </div>
  );
}

function TaskList({
  tasks,
  onMove,
  updatingTaskId,
}: {
  tasks: Task[];
  onMove: (task: Task, status: TaskStatus) => void;
  updatingTaskId?: string;
}) {
  return (
    <section className="task-list-view">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          isUpdating={task.id === updatingTaskId}
          onMove={onMove}
        />
      ))}
      {tasks.length === 0 && (
        <div className="empty-state">No tasks match these filters.</div>
      )}
    </section>
  );
}

function TaskCard({
  task,
  onMove,
  onDragStart,
  onDragEnd,
  isDragging = false,
  isUpdating = false,
}: {
  task: Task;
  onMove?: (task: Task, status: TaskStatus) => void;
  onDragStart?: (event: DragEvent<HTMLAnchorElement>) => void;
  onDragEnd?: () => void;
  isDragging?: boolean;
  isUpdating?: boolean;
}) {
  return (
    <Link
      className={`task-card${isDragging ? ' is-dragging' : ''}`}
      draggable={Boolean(onDragStart)}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      to={`/tasks/${task.id}`}
    >
      <div className="task-card-top">
        <span
          className={`priority-indicator priority-${task.priority ?? 'none'}`}
          aria-label={
            task.priority ? TASK_PRIORITY_LABELS[task.priority] : 'No priority'
          }
        />
        {task.priority && (
          <span className="task-priority">
            {TASK_PRIORITY_LABELS[task.priority]}
          </span>
        )}
        <span className="task-id">
          {task.id.replace(/^tsk_/, '#').slice(0, 9)}
        </span>
      </div>
      <strong className="task-card-title">{task.title}</strong>
      {task.description && <p>{task.description}</p>}
      <div className="task-card-footer">
        <span className="task-assignee">R</span>
        <span className="task-revision">↻ {task.revision}</span>
        {onMove && (
          <AppSelect
            value={task.status}
            disabled={isUpdating}
            onValueChange={(value) => onMove(task, value as TaskStatus)}
            options={TASK_COLUMNS.map((status) => ({
              value: status,
              label: TASK_STATUS_LABELS[status],
            }))}
            ariaLabel="Change task status"
            className="task-status-select"
            stopPropagation
          />
        )}
      </div>
    </Link>
  );
}

function CreateTaskDialog({
  open,
  title,
  description,
  priority,
  repositoryId,
  repositories,
  pending,
  error,
  onTitle,
  onDescription,
  onPriority,
  onRepository,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  priority: TaskPriority | '';
  repositoryId: string;
  repositories: Awaited<ReturnType<typeof api.repositories>>;
  pending: boolean;
  error: unknown;
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
  onPriority: (value: TaskPriority | '') => void;
  onRepository: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <AppDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title="Create task"
      description="Add a focused piece of work to your workspace."
      className="task-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label>
          Title
          <input
            autoFocus
            value={title}
            onChange={(event) => onTitle(event.target.value)}
            required
            placeholder="What needs to be done?"
          />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(event) => onDescription(event.target.value)}
            placeholder="Add context for the task…"
          />
        </label>
        <div className="grid two">
          <label>
            Priority
            <AppSelect
              value={priority}
              onValueChange={(value) => onPriority(value as TaskPriority | '')}
              options={[
                { value: '', label: 'No priority' },
                ...TASK_PRIORITIES.map((value) => ({
                  value,
                  label: TASK_PRIORITY_LABELS[value],
                })),
              ]}
              placeholder="No priority"
            />
          </label>
          <label>
            Repository
            <AppSelect
              value={repositoryId}
              onValueChange={onRepository}
              options={[
                { value: '', label: 'Not linked' },
                ...repositories.map((repository) => ({
                  value: repository.id,
                  label: repository.name,
                })),
              ]}
              placeholder="Not linked"
            />
          </label>
        </div>
        {error instanceof Error && <ErrorNotice error={error} />}
        <div className="dialog-actions">
          <Dialog.Close asChild>
            <button type="button" className="secondary">
              Cancel
            </button>
          </Dialog.Close>
          <button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </AppDialog>
  );
}

function TaskPage() {
  const { taskId } = useParams();
  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.task(taskId ?? ''),
    enabled: Boolean(taskId),
  });
  const taskRuns = useQuery({
    queryKey: ['task-runs', taskId],
    queryFn: () => api.taskRuns(taskId ?? ''),
    enabled: Boolean(taskId),
  });
  const runners = useQuery({ queryKey: ['runners'], queryFn: api.runners });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: api.repositories,
  });
  const navigate = useNavigate();
  const client = useQueryClient();
  const task = taskQuery.data;
  const selectedRepository = repositories.data?.find(
    (repository) => repository.id === task?.repositoryId,
  );
  const [runnerId, setRunnerId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [baseRef, setBaseRef] = useState('main');
  const [prompt, setPrompt] = useState('');
  useEffect(() => {
    if (selectedRepository) setBaseRef(selectedRepository.defaultRef);
  }, [selectedRepository?.id, selectedRepository?.defaultRef]);
  const create = useMutation({
    mutationFn: () =>
      api.createRun(taskId ?? '', {
        runnerId,
        agentProfileId: profileId,
        baseRef,
        initialPrompt: prompt,
        runConfig: {
          agentProfileId: profileId,
          permissionMode: 'ask',
          toolPolicy: {
            filesystem: 'worktree_only',
            network: 'unrestricted',
            shell: 'ask',
            gitPush: false,
          },
          idleTimeoutMinutes: 30,
          maxTurnMinutes: 60,
        },
      }),
    onSuccess: (value) => {
      if (value && typeof value === 'object' && 'id' in value)
        navigate(`/runs/${String(value.id)}`);
    },
  });
  const bindRepository = useMutation({
    mutationFn: (repositoryId: string | null) =>
      api.updateTask(taskId ?? '', {
        revision: task?.revision ?? 0,
        repositoryId,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const availableProfiles =
    profiles.data?.filter(
      (profile) => !runnerId || profile.runnerId === runnerId,
    ) ?? [];
  const selectedProfile = availableProfiles.find(
    (profile) => profile.id === profileId,
  );
  if (
    taskQuery.isPending ||
    taskRuns.isPending ||
    runners.isPending ||
    profiles.isPending ||
    repositories.isPending
  )
    return <p>加载任务配置…</p>;
  if (
    taskQuery.error ||
    taskRuns.error ||
    runners.error ||
    profiles.error ||
    repositories.error
  )
    return (
      <ErrorNotice
        error={
          taskQuery.error ??
          taskRuns.error ??
          runners.error ??
          profiles.error ??
          repositories.error
        }
      />
    );
  if (!task) return <ErrorNotice error={new Error('Task not found')} />;
  return (
    <div className="grid">
      <Link className="muted back-link" to="/">
        <ArrowLeft size={14} strokeWidth={1.8} /> 返回任务
      </Link>
      <section className="card">
        <h2 className="title">{task.title}</h2>
        <p>{task.description || '无描述'}</p>
        <div className="row">
          <span className="badge">{task.status}</span>
          <span className="muted">revision {task.revision}</span>
        </div>
      </section>
      <section className="card">
        <h3>历史 Run</h3>
        {taskRuns.data.length === 0 ? (
          <p className="muted">还没有执行记录。</p>
        ) : (
          <div className="list">
            {taskRuns.data.map((run) => (
              <Link className="list-item" key={run.id} to={`/runs/${run.id}`}>
                <div
                  className="row"
                  style={{ justifyContent: 'space-between' }}
                >
                  <strong>{run.id}</strong>
                  <span className={`badge ${run.status}`}>{run.status}</span>
                </div>
                <p className="muted small">
                  {new Date(run.createdAt).toLocaleString()}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
      <section className="card">
        <h3>Repository</h3>
        <label>
          绑定代码库
          <AppSelect
            value={task.repositoryId ?? ''}
            disabled={bindRepository.isPending}
            onValueChange={(value) => bindRepository.mutate(value || null)}
            options={[
              { value: '', label: '不绑定' },
              ...repositories.data.map((repository) => ({
                value: repository.id,
                label: `${repository.name} (${repository.defaultRef})`,
              })),
            ]}
            placeholder="不绑定"
          />
        </label>
        {bindRepository.error && <ErrorNotice error={bindRepository.error} />}
      </section>
      <section className="card">
        <h3>创建 Run</h3>
        {task.repositoryId ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <label>
              Runner
              <AppSelect
                value={runnerId}
                onValueChange={(value) => {
                  setRunnerId(value);
                  setProfileId('');
                }}
                options={[
                  { value: '', label: '选择 Runner' },
                  ...runners.data.map((runner) => ({
                    value: runner.id,
                    label: `${runner.name} (${runner.status})`,
                  })),
                ]}
                placeholder="选择 Runner"
                required
              />
            </label>
            <label>
              Agent Profile
              <AppSelect
                value={profileId}
                onValueChange={setProfileId}
                options={[
                  { value: '', label: '选择 Profile' },
                  ...availableProfiles.map((profile) => ({
                    value: profile.id,
                    label: `${profile.displayName} · ${profile.engine}`,
                  })),
                ]}
                placeholder="选择 Profile"
                required
              />
            </label>
            {selectedProfile?.capabilitySnapshot && (
              <div className="notice small">
                <strong>EnforcementReport</strong> · filesystem{' '}
                {selectedProfile.capabilitySnapshot.enforcement.filesystem} ·
                network {selectedProfile.capabilitySnapshot.enforcement.network}
              </div>
            )}
            <label>
              Base ref
              <input
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                required
              />
            </label>
            <p className="muted small">
              创建 Run 时，Runner 会读取此 ref 的最新本地
              commit；不会自动拉取远程仓库。
            </p>
            <label>
              初始 prompt
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                required
              />
            </label>
            <button disabled={create.isPending}>发起 Run</button>
          </form>
        ) : (
          <div className="notice">请先为任务绑定 Repository，再创建 Run。</div>
        )}
        {create.error && <ErrorNotice error={create.error} />}
      </section>
    </div>
  );
}

function RunnersPage() {
  const client = useQueryClient();
  const runners = useQuery({ queryKey: ['runners'], queryFn: api.runners });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  const repositories = useQuery({
    queryKey: ['repositories'],
    queryFn: api.repositories,
  });
  const [runnerName, setRunnerName] = useState('');
  const [profileRunnerId, setProfileRunnerId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileEngine, setProfileEngine] = useState<'claude-code' | 'pi'>(
    'pi',
  );
  const [profileModel, setProfileModel] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [repositoryRemote, setRepositoryRemote] = useState('');
  const [repositoryRef, setRepositoryRef] = useState('main');
  const [pairing, setPairing] = useState<{
    pairingCode: string;
    expiresAt: string;
  } | null>(null);
  const createRunner = useMutation({
    mutationFn: () =>
      api.createRunner({ name: runnerName, kind: 'local', maxConcurrency: 1 }),
    onSuccess: (value) => {
      setRunnerName('');
      setPairing(value);
      void client.invalidateQueries({ queryKey: ['runners'] });
    },
  });
  const createProfile = useMutation({
    mutationFn: () =>
      api.createProfile({
        runnerId: profileRunnerId,
        displayName: profileName,
        engine: profileEngine,
        launch: { kind: 'managed' },
        defaultModel: profileModel.trim() || undefined,
      }),
    onSuccess: () => {
      setProfileName('');
      setProfileModel('');
      void client.invalidateQueries({ queryKey: ['profiles'] });
    },
  });
  const createRepository = useMutation({
    mutationFn: () =>
      api.createRepository({
        name: repositoryName,
        remoteUrl: repositoryRemote.trim() || null,
        defaultRef: repositoryRef,
        access: 'write',
      }),
    onSuccess: () => {
      setRepositoryName('');
      setRepositoryRemote('');
      void client.invalidateQueries({ queryKey: ['repositories'] });
    },
  });
  if (runners.isPending || profiles.isPending || repositories.isPending)
    return <p>加载 Runner…</p>;
  if (runners.error || profiles.error || repositories.error)
    return (
      <ErrorNotice
        error={runners.error ?? profiles.error ?? repositories.error}
      />
    );
  return (
    <div className="grid">
      <div>
        <h2 className="title">Runners</h2>
        <p className="muted">
          Runner 使用主动出站 WebSocket；token 只在配对时显示。
        </p>
      </div>
      <section className="grid two">
        <section className="card">
          <h3>创建 Runner</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              createRunner.mutate();
            }}
          >
            <label>
              名称
              <input
                value={runnerName}
                onChange={(event) => setRunnerName(event.target.value)}
                required
              />
            </label>
            <button disabled={createRunner.isPending}>生成配对码</button>
          </form>
          {pairing && (
            <div className="notice small">
              配对码：<code>{pairing.pairingCode}</code>
              <br />
              过期：{new Date(pairing.expiresAt).toLocaleString()}
            </div>
          )}
          {createRunner.error && <ErrorNotice error={createRunner.error} />}
        </section>
        <section className="card">
          <h3>创建 Agent Profile</h3>
          {runners.data.length === 0 ? (
            <p className="muted">请先创建 Runner。</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                createProfile.mutate();
              }}
            >
              <label>
                Runner
                <AppSelect
                  value={profileRunnerId}
                  onValueChange={setProfileRunnerId}
                  options={[
                    { value: '', label: '选择 Runner' },
                    ...runners.data.map((runner) => ({
                      value: runner.id,
                      label: runner.name,
                    })),
                  ]}
                  placeholder="选择 Runner"
                  required
                />
              </label>
              <label>
                显示名称
                <input
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  required
                />
              </label>
              <label>
                Engine
                <AppSelect
                  value={profileEngine}
                  onValueChange={(value) =>
                    setProfileEngine(value as 'claude-code' | 'pi')
                  }
                  options={[
                    { value: 'pi', label: 'pi' },
                    { value: 'claude-code', label: 'claude-code' },
                  ]}
                />
                <span className="muted small">
                  Pi 使用本机 `pi --mode rpc`；Claude Code 使用 ACP。
                </span>
              </label>
              <label>
                默认模型（可选）
                <input
                  value={profileModel}
                  onChange={(event) => setProfileModel(event.target.value)}
                />
              </label>
              <button disabled={createProfile.isPending}>创建 Profile</button>
            </form>
          )}
          {createProfile.error && <ErrorNotice error={createProfile.error} />}
        </section>
        <section className="card">
          <h3>注册 Repository</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              createRepository.mutate();
            }}
          >
            <label>
              名称
              <input
                value={repositoryName}
                onChange={(event) => setRepositoryName(event.target.value)}
                required
              />
            </label>
            <label>
              Remote URL（可选）
              <input
                value={repositoryRemote}
                onChange={(event) => setRepositoryRemote(event.target.value)}
                placeholder="本机路径或远程 URL"
              />
            </label>
            <label>
              默认 ref
              <input
                value={repositoryRef}
                onChange={(event) => setRepositoryRef(event.target.value)}
                required
              />
            </label>
            <button disabled={createRepository.isPending}>注册</button>
          </form>
          {createRepository.error && (
            <ErrorNotice error={createRepository.error} />
          )}
        </section>
      </section>
      <section className="grid two">
        {runners.data.map((runner) => (
          <RunnerCard
            key={runner.id}
            runner={runner}
            profiles={profiles.data.filter(
              (profile) => profile.runnerId === runner.id,
            )}
          />
        ))}
      </section>
      <section className="card">
        <h3>Repositories</h3>
        {repositories.data.length === 0 ? (
          <p className="muted">还没有 Repository。</p>
        ) : (
          <ul>
            {repositories.data.map((repository) => (
              <li key={repository.id}>
                {repository.name} · {repository.defaultRef} ·{' '}
                {repository.status}
              </li>
            ))}
          </ul>
        )}
      </section>
      {runners.data.length === 0 && (
        <div className="card muted">还没有 Runner。</div>
      )}
    </div>
  );
}

function RunnerCard({
  runner,
  profiles,
}: {
  runner: Runner;
  profiles: AgentProfile[];
}) {
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{runner.name}</strong>
        <span className={`badge ${runner.status}`}>{runner.status}</span>
      </div>
      <p className="muted small">
        {runner.os ?? 'unknown'} / {runner.arch ?? 'unknown'} · capacity{' '}
        {runner.maxConcurrency}
      </p>
      <h4>Agent Profiles</h4>
      {profiles.length ? (
        <ul>
          {profiles.map((profile) => (
            <li key={profile.id}>
              {profile.displayName} · {profile.engine} ·{' '}
              {profile.capabilitySnapshot?.protocol ?? '未探测'}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">未配置 Profile。</p>
      )}
    </section>
  );
}

type StreamView = {
  events: RunEvent[];
  chunks: TranscriptChunk[];
  lastSequence: number;
  lastChunkSeq: number;
};

function useAttemptStream(snapshot: RunSnapshot | undefined) {
  const streams = useRef(new Map<string, AttemptStream>());
  const client = useQueryClient();
  const [, redraw] = useState(0);
  const attemptIds = snapshot?.attempts.map((attempt) => attempt.id).join(',');
  const runId = snapshot?.run.id;
  useEffect(() => {
    if (!snapshot || !runId) return;
    let cancelled = false;
    const load = async () => {
      for (const attempt of snapshot.attempts) {
        if (cancelled) return;
        const stream =
          streams.current.get(attempt.id) ?? new AttemptStream(attempt.id);
        streams.current.set(attempt.id, stream);
        const transcriptRequest =
          attempt.lastChunkSeq > 0
            ? api.transcriptBefore(attempt.id, attempt.lastChunkSeq + 1)
            : api.transcript(attempt.id, 0);
        const [events, transcript] = await Promise.all([
          api.events(attempt.id, 0),
          transcriptRequest,
        ]);
        if (cancelled) return;
        stream.hydrate({
          events: events.events.map((event) => RunEventSchema.parse(event)),
          chunks: transcript.chunks.map((chunk) =>
            TranscriptChunkSchema.parse(chunk),
          ),
          cursor: {
            eventCursor: attempt.lastSequence,
            chunkCursor: attempt.lastChunkSeq,
          },
        });
      }
      if (!cancelled) redraw((value) => value + 1);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [runId, attemptIds]);
  useEffect(() => {
    if (!runId) return;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let disposed = false;
    const reconnectSnapshot = () => {
      void client.invalidateQueries({ queryKey: ['run', runId] });
    };
    let delay = 1_000;
    const backfillEvents = async (stream: AttemptStream) => {
      try {
        const history = await api.events(stream.attemptId, stream.lastSequence);
        stream.appendHistory({
          events: history.events.map((event) => RunEventSchema.parse(event)),
          chunks: [],
          cursor: {
            eventCursor: stream.lastSequence,
            chunkCursor: stream.lastChunkSeq,
          },
        });
      } catch {
        reconnectSnapshot();
      }
    };
    const backfillTranscript = async (stream: AttemptStream) => {
      try {
        const history = await api.transcript(
          stream.attemptId,
          stream.lastChunkSeq,
        );
        stream.appendHistory({
          events: [],
          chunks: history.chunks.map((item) =>
            TranscriptChunkSchema.parse(item),
          ),
          cursor: {
            eventCursor: stream.lastSequence,
            chunkCursor: stream.lastChunkSeq,
          },
        });
      } catch {
        reconnectSnapshot();
      }
    };
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(
        `${window.location.origin.replace(/^http/, 'ws')}/ws/client`,
      );
      socket.onopen = () => {
        delay = 1_000;
        socket?.send(JSON.stringify({ type: 'subscribe', runId }));
        reconnectSnapshot();
      };
      socket.onmessage = (message) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const parsed = BrowserServerMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        if (parsed.data.type === 'run') {
          reconnectSnapshot();
          return;
        }
        const stream =
          streams.current.get(parsed.data.attemptId) ??
          new AttemptStream(parsed.data.attemptId);
        streams.current.set(parsed.data.attemptId, stream);
        if (parsed.data.type === 'event') {
          const result = stream.acceptEvent(parsed.data.event);
          reconnectSnapshot();
          if (result === 'gap')
            void backfillEvents(stream).then(() =>
              redraw((value) => value + 1),
            );
        } else {
          const chunk = TranscriptChunkSchema.parse({
            attemptId: parsed.data.attemptId,
            chunkSeq: parsed.data.chunkSeq,
            turnId: parsed.data.turnId,
            frames: parsed.data.frames,
            frameCount: parsed.data.frames.length,
            byteSize: JSON.stringify(parsed.data.frames).length,
            createdAt: new Date().toISOString(),
          });
          const result = stream.acceptChunk(chunk);
          if (result === 'gap')
            void backfillTranscript(stream).then(() =>
              redraw((value) => value + 1),
            );
        }
        redraw((value) => value + 1);
      };
      socket.onclose = () => {
        if (!disposed) {
          timer = window.setTimeout(
            connect,
            delay + Math.round(Math.random() * 250),
          );
          delay = Math.min(delay * 2, 30_000);
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      socket?.close();
    };
  }, [runId]);
  return (attemptId: string): StreamView => {
    const stream = streams.current.get(attemptId);
    return stream
      ? {
          events: stream.events,
          chunks: stream.chunks,
          lastSequence: stream.lastSequence,
          lastChunkSeq: stream.lastChunkSeq,
        }
      : { events: [], chunks: [], lastSequence: 0, lastChunkSeq: 0 };
  };
}

function RunPage() {
  const { runId } = useParams();
  const client = useQueryClient();
  const run = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.run(runId ?? ''),
    enabled: Boolean(runId),
    refetchInterval: 5_000,
  });
  const stream = useAttemptStream(run.data);
  const [prompt, setPrompt] = useState('');
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [timelineQuery, setTimelineQuery] = useState('');
  const [showThoughts, setShowThoughts] = useState(false);
  const action = useMutation({
    mutationFn: (input: {
      kind: 'prompt' | 'cancel' | 'close' | 'retry';
      attemptId?: string;
      text?: string;
    }) =>
      input.kind === 'prompt'
        ? api.prompt(input.attemptId ?? '', input.text ?? '')
        : input.kind === 'cancel'
          ? api.cancelAttempt(input.attemptId ?? '')
          : input.kind === 'close'
            ? api.closeAttempt(input.attemptId ?? '')
            : api.retry(runId ?? '', 'last_commit'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['run', runId] });
    },
  });
  if (run.isPending) return <p>加载 Run…</p>;
  if (run.error || !run.data)
    return <ErrorNotice error={run.error ?? new Error('Run not found')} />;
  const current =
    run.data.attempts.find(
      (attempt) => attempt.id === run.data.run.currentAttemptId,
    ) ?? run.data.attempts.at(-1);
  if (!current) return <div className="notice">Run 没有 Attempt。</div>;
  const view = stream(current.id);
  const turns = run.data.turns
    .filter((turn) => turn.attemptId === current.id)
    .sort((left, right) => left.number - right.number);
  const timeline = buildTimeline(view.events, turns).filter((entry) => {
    const query = timelineQuery.trim().toLocaleLowerCase();
    if (!query) return true;
    if (entry.kind === 'turn')
      return (
        entry.turn.prompt.toLocaleLowerCase().includes(query) ||
        entry.turn.status.includes(query)
      );
    return (
      entry.event.type.includes(query) ||
      JSON.stringify(entry.event.payload).toLocaleLowerCase().includes(query)
    );
  });
  const transcriptChunks = filterTranscriptChunks(view.chunks, transcriptQuery);
  const downloadTranscript = () => {
    const blob = new Blob([transcriptToText(transcriptChunks)], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `run-${run.data.run.id}-transcript.txt`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div className="grid">
      <Link className="muted back-link" to={`/tasks/${run.data.run.taskId}`}>
        <ArrowLeft size={14} strokeWidth={1.8} /> 返回任务
      </Link>
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="title">Run {run.data.run.id}</h2>
            <p className="muted">
              Attempt #{current.number} · {current.branchName}
            </p>
          </div>
          <span className={`badge ${current.status}`}>{current.status}</span>
        </div>
        <div className="row">
          <button
            disabled={
              action.isPending ||
              !['idle', 'running', 'waiting_approval'].includes(current.status)
            }
            onClick={() =>
              action.mutate({ kind: 'cancel', attemptId: current.id })
            }
          >
            取消 Run
          </button>
          <button
            className="secondary"
            disabled={action.isPending || current.status === 'completed'}
            onClick={() =>
              action.mutate({ kind: 'close', attemptId: current.id })
            }
          >
            完成
          </button>
          {['failed', 'canceled', 'lost'].includes(current.status) && (
            <button
              className="secondary"
              onClick={() => action.mutate({ kind: 'retry' })}
            >
              从最后提交重试
            </button>
          )}
        </div>
      </section>
      {current.enforcement && (
        <section className="card">
          <h3>EnforcementReport</h3>
          <div className="row">
            <span className="badge">{current.enforcement.filesystem}</span>
            <span className="muted">
              network {current.enforcement.network} · shell{' '}
              {current.enforcement.shell} · git push{' '}
              {current.enforcement.gitPush}
            </span>
          </div>
        </section>
      )}
      <section className="card">
        <div className="run-section-heading">
          <div>
            <h3>Run timeline</h3>
            <p className="muted small">{timeline.length} entries</p>
          </div>
          <label className="run-search">
            <Search size={14} strokeWidth={1.8} />
            <input
              aria-label="Search timeline"
              value={timelineQuery}
              onChange={(event) => setTimelineQuery(event.target.value)}
              placeholder="Search events…"
            />
          </label>
        </div>
        <Timeline entries={timeline} />
      </section>
      <section className="card">
        <div className="run-section-heading">
          <div>
            <h3>转写</h3>
            <p className="muted small">
              {transcriptChunks.length} chunks ·{' '}
              {countTranscriptFrames(transcriptChunks)} frames
            </p>
          </div>
          <div className="run-tools">
            <label className="run-search">
              <Search size={14} strokeWidth={1.8} />
              <input
                aria-label="Search transcript"
                value={transcriptQuery}
                onChange={(event) => setTranscriptQuery(event.target.value)}
                placeholder="Search transcript…"
              />
            </label>
            <button
              className="secondary compact-button"
              disabled={transcriptChunks.length === 0}
              onClick={downloadTranscript}
              type="button"
            >
              <Download size={14} strokeWidth={1.8} /> 下载
            </button>
            <button
              className="secondary compact-button"
              onClick={() => setShowThoughts((value) => !value)}
              type="button"
            >
              {showThoughts ? '隐藏思考' : '显示思考'}
            </button>
          </div>
        </div>
        <Transcript chunks={transcriptChunks} showThoughts={showThoughts} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (prompt.trim()) {
              action.mutate({
                kind: 'prompt',
                attemptId: current.id,
                text: prompt,
              });
              setPrompt('');
            }
          }}
        >
          <label>
            追加 prompt
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Attempt idle 后继续对话"
            />
          </label>
          <button disabled={action.isPending || current.status !== 'idle'}>
            发送
          </button>
        </form>
      </section>
      <section className="card">
        <h3>每 Turn Diff</h3>
        {turns.length === 0 ? (
          <p className="muted">还没有 Turn。</p>
        ) : (
          <div className="list">
            {turns.map((turn) => (
              <div className="list-item" key={turn.id}>
                <div
                  className="row"
                  style={{ justifyContent: 'space-between' }}
                >
                  <strong>Turn #{turn.number}</strong>
                  <span className={`badge ${turn.status}`}>{turn.status}</span>
                </div>
                <p className="muted small">
                  {turn.diffStats
                    ? `${turn.diffStats.files} files · +${turn.diffStats.additions}/-${turn.diffStats.deletions}`
                    : '无 diff stats'}
                  {turn.commitSha ? ` · ${turn.commitSha.slice(0, 12)}` : ''}
                </p>
                {turn.patchArtifactId && (
                  <a
                    className="badge"
                    href={`/api/v1/artifacts/${encodeURIComponent(
                      turn.patchArtifactId,
                    )}/download`}
                  >
                    下载 patch
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <Approvals
        approvals={run.data.approvals}
        onResolve={(approval, decision) => {
          void api
            .resolveApproval(approval.id, decision)
            .then(() => client.invalidateQueries({ queryKey: ['run', runId] }));
        }}
      />
    </div>
  );
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0)
    return <div className="empty-state">No timeline entries match.</div>;
  return (
    <div className="timeline">
      {entries.map((entry) => (
        <div
          className={`timeline-entry timeline-${entry.kind}`}
          key={
            entry.kind === 'turn'
              ? `turn:${entry.turn.id}`
              : `event:${entry.event.attemptId}:${entry.event.sequence}`
          }
        >
          <span className="timeline-marker" />
          <div className="timeline-content">
            <div className="run-section-heading">
              <strong>
                {entry.kind === 'turn'
                  ? `Turn #${entry.turn.number}`
                  : entry.event.type}
              </strong>
              <time className="muted small">
                {new Date(entry.at).toLocaleTimeString()}
              </time>
            </div>
            {entry.kind === 'turn' ? (
              <p className="small">{entry.turn.prompt}</p>
            ) : (
              <p className="muted small">
                {JSON.stringify(entry.event.payload)}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Transcript({
  chunks,
  showThoughts,
}: {
  chunks: TranscriptChunk[];
  showThoughts: boolean;
}) {
  return (
    <div className="transcript">
      {chunks.length === 0 ? (
        <span className="muted">等待 Agent 输出或没有匹配内容…</span>
      ) : (
        chunks.flatMap((chunk) =>
          chunk.frames.map((frame, index) => (
            <Frame
              key={`${chunk.chunkSeq}:${index}`}
              frame={frame}
              showThoughts={showThoughts}
            />
          )),
        )
      )}
    </div>
  );
}

function Frame({
  frame,
  showThoughts,
}: {
  frame: TranscriptChunk['frames'][number];
  showThoughts: boolean;
}) {
  if (frame.t === 'text_delta')
    return <div className="frame">{frame.text}</div>;
  if (frame.t === 'thought_delta')
    return (
      <details className="tool thought-tool" open={showThoughts}>
        <summary>思考</summary>
        <div className="frame thought">{frame.text}</div>
      </details>
    );
  if (frame.t === 'warning')
    return (
      <div className="frame warning">
        [{frame.code}] {frame.message}
      </div>
    );
  if (frame.t === 'tool_call')
    return (
      <details className="tool" open={showThoughts}>
        <summary>{frame.tool}</summary>
        <pre>{JSON.stringify(frame.input, null, 2)}</pre>
      </details>
    );
  if (frame.t === 'tool_result')
    return (
      <details className="tool">
        <summary>tool result</summary>
        <pre>{frame.output}</pre>
      </details>
    );
  if (frame.t === 'file_changed')
    return (
      <div className="frame muted">
        changed {frame.path} (+{frame.add}/-{frame.del})
      </div>
    );
  if (frame.t === 'plan_updated')
    return (
      <details className="tool">
        <summary>计划</summary>
        <pre>{JSON.stringify(frame.plan, null, 2)}</pre>
      </details>
    );
  return (
    <div className="muted small">
      usage {frame.usage.inputTokens} in / {frame.usage.outputTokens} out
    </div>
  );
}

function Approvals({
  approvals,
  onResolve,
}: {
  approvals: ApprovalRequest[];
  onResolve: (
    approval: ApprovalRequest,
    decision: 'allow' | 'deny' | 'allow_always',
  ) => void;
}) {
  if (approvals.length === 0) return null;
  return (
    <section className="card">
      <h3>待审批</h3>
      <div className="list">
        {approvals.map((approval) => (
          <div className="list-item" key={approval.id}>
            <strong>{approval.title}</strong>
            <p className="muted small">{approval.kind}</p>
            <pre>{JSON.stringify(approval.payload, null, 2)}</pre>
            <div className="row">
              <button onClick={() => onResolve(approval, 'allow')}>
                允许一次
              </button>
              <button
                className="secondary"
                onClick={() => onResolve(approval, 'allow_always')}
              >
                本 Attempt 总是允许
              </button>
              <button
                className="danger"
                onClick={() => onResolve(approval, 'deny')}
              >
                拒绝
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AppRoot() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  if (me.isPending)
    return (
      <main className="auth">
        <p>连接服务端…</p>
      </main>
    );
  if (me.error instanceof ApiError && me.error.status === 401)
    return <AuthPage />;
  if (me.error)
    return (
      <main className="auth">
        <ErrorNotice error={me.error} />
      </main>
    );
  return <Layout />;
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppRoot />,
    children: [
      { index: true, element: <TasksPage /> },
      { path: 'tasks/:taskId', element: <TaskPage /> },
      { path: 'runs/:runId', element: <RunPage /> },
      { path: 'runners', element: <RunnersPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
