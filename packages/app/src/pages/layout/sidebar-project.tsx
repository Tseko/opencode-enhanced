import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { createSortable } from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { type LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { ProjectIcon, type SessionItemProps } from "./sidebar-items"
import { displayName } from "./helpers"
import {
  LocalWorkspace,
  SortableWorkspace,
  WorkspaceDragOverlay,
  type WorkspaceSidebarContext,
} from "./sidebar-workspace"

export type ProjectSidebarContext = {
  currentDir: Accessor<string>
  currentProject: Accessor<LocalProject | undefined>
  sidebarHovering: Accessor<boolean>
  navigateToProject: (directory: string) => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  workspaceIds: (project: LocalProject) => string[]
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
  sessionProps: Omit<SessionItemProps, "session" | "list" | "slug" | "mobile" | "dense">
  projectExpanded: (worktree: string) => boolean
  setProjectExpanded: (worktree: string, value: boolean) => void
  onNewSession: (project: LocalProject) => void
  createWorkspace: (project: LocalProject) => Promise<void> | void
  workspaceCtx: WorkspaceSidebarContext
  handleWorkspaceDragStart: (event: unknown) => void
  handleWorkspaceDragEnd: () => void
  handleWorkspaceDragOver: (event: DragEvent) => void
  activeWorkspace: Accessor<string | undefined>
}

export const ProjectDragOverlay = (props: {
  projects: Accessor<LocalProject[]>
  activeProject: Accessor<string | undefined>
}): JSX.Element => {
  const project = createMemo(() => props.projects().find((item) => item.worktree === props.activeProject()))
  return (
    <Show when={project()}>
      {(item) => (
        <div class="flex items-center gap-2 rounded-md bg-background-base px-2 py-1">
          <ProjectIcon project={item()} />
          <span class="text-14-medium text-text-strong">{displayName(item())}</span>
        </div>
      )}
    </Show>
  )
}

export const SortableProject = (props: {
  project: LocalProject
  mobile?: boolean
  ctx: ProjectSidebarContext
  sortNow: Accessor<number>
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const notification = useNotification()
  const sortable = createSortable(props.project.worktree)
  const selected = createMemo(() => props.ctx.currentProject()?.worktree === props.project.worktree)
  const expanded = createMemo(() => props.ctx.projectExpanded(props.project.worktree))
  const dirs = createMemo(() => props.ctx.workspaceIds(props.project))
  const workspacesEnabled = createMemo(() => props.ctx.workspacesEnabled(props.project))
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const isWorking = createMemo(() =>
    dirs().some((directory) =>
      Object.keys(serverSync().session.data.session_status).some((id) => {
        if (serverSync().session.get(id)?.directory !== directory) return false
        return serverSync().session.data.session_working(id)
      }),
    ),
  )
  const homedir = createMemo(() => serverSync().data.path.home)
  const pathLabel = createMemo(() => props.project.worktree.replace(homedir(), "~"))
  const [state, setState] = createStore({ menu: false })

  const clearNotifications = () =>
    dirs()
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))

  const openProject = () => {
    props.ctx.setProjectExpanded(props.project.worktree, true)
    if (selected()) return
    props.ctx.navigateToProject(props.project.worktree)
  }

  return (
    // @ts-ignore
    <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
      <Collapsible
        variant="ghost"
        open={expanded()}
        class="shrink-0"
        onOpenChange={(value) => props.ctx.setProjectExpanded(props.project.worktree, value)}
      >
        <div class="group/project flex items-center gap-0.5 rounded-md px-1 py-0.5 hover:bg-surface-raised-base-hover">
          <Collapsible.Trigger
            class="flex size-6 shrink-0 items-center justify-center rounded-md text-icon-base"
            data-action="project-toggle"
            data-project={slug()}
            aria-label={displayName(props.project)}
          >
            <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
          </Collapsible.Trigger>
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1 text-left"
            data-action="project-switch"
            data-project={slug()}
            onClick={openProject}
          >
            <ProjectIcon project={props.project} notify working={isWorking()} />
            <span
              classList={{
                "min-w-0 flex-1 truncate text-14-medium": true,
                "text-text-strong": selected(),
                "text-text-base": !selected(),
              }}
            >
              {displayName(props.project)}
            </span>
          </button>
          <div
            class="flex shrink-0 items-center gap-0.5"
            classList={{
              "opacity-100": props.mobile || state.menu,
              "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100":
                !props.mobile && !state.menu,
            }}
          >
            <Tooltip value={language.t("command.session.new")} placement="top">
              <IconButton
                icon="plus-small"
                variant="ghost"
                class="size-6 rounded-md"
                aria-label={language.t("command.session.new")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.ctx.setProjectExpanded(props.project.worktree, true)
                  props.ctx.onNewSession(props.project)
                }}
              />
            </Tooltip>
            <DropdownMenu modal={!props.ctx.sidebarHovering()} onOpenChange={(value) => setState("menu", value)}>
              <DropdownMenu.Trigger
                as={IconButton}
                icon="dot-grid"
                variant="ghost"
                data-action="project-menu"
                data-project={slug()}
                class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                aria-label={language.t("common.moreOptions")}
              />
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="mt-1">
                  <DropdownMenu.Item onSelect={() => props.ctx.showEditProjectDialog(props.project)}>
                    <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    data-action="project-workspaces-toggle"
                    data-project={slug()}
                    disabled={props.project.vcs !== "git" && !workspacesEnabled()}
                    onSelect={() => props.ctx.toggleProjectWorkspaces(props.project)}
                  >
                    <DropdownMenu.ItemLabel>
                      {workspacesEnabled()
                        ? language.t("sidebar.workspaces.disable")
                        : language.t("sidebar.workspaces.enable")}
                    </DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    data-action="project-clear-notifications"
                    data-project={slug()}
                    disabled={unseenCount() === 0}
                    onSelect={clearNotifications}
                  >
                    <DropdownMenu.ItemLabel>{language.t("sidebar.project.clearNotifications")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    data-action="project-close-menu"
                    data-project={slug()}
                    onSelect={() => props.ctx.closeProject(props.project.worktree)}
                  >
                    <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </div>
        </div>
        <Show when={!expanded()}>
          <div class="px-8 pb-1">
            <span class="block truncate text-12-regular text-text-weak">{pathLabel()}</span>
          </div>
        </Show>
        <Collapsible.Content>
          <div class="flex flex-col pb-2 pl-3">
            <Show
              when={workspacesEnabled()}
              fallback={
                <LocalWorkspace
                  ctx={props.ctx.workspaceCtx}
                  project={props.project}
                  sortNow={props.sortNow}
                  mobile={props.mobile}
                  embedded
                />
              }
            >
              <div class="px-2 pb-2 pt-1">
                <Button
                  size="large"
                  icon="plus-small"
                  class="w-full"
                  onClick={() => {
                    void props.ctx.createWorkspace(props.project)
                  }}
                >
                  {language.t("workspace.new")}
                </Button>
              </div>
              <DragDropProvider
                onDragStart={props.ctx.handleWorkspaceDragStart}
                onDragEnd={props.ctx.handleWorkspaceDragEnd}
                onDragOver={props.ctx.handleWorkspaceDragOver}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <ConstrainDragXAxis />
                <div class="flex flex-col gap-2 py-1">
                  <SortableProvider ids={dirs()}>
                    <For each={dirs()}>
                      {(directory) => (
                        <SortableWorkspace
                          ctx={props.ctx.workspaceCtx}
                          directory={directory}
                          project={props.project}
                          sortNow={props.sortNow}
                          mobile={props.mobile}
                        />
                      )}
                    </For>
                  </SortableProvider>
                </div>
                <DragOverlay>
                  <WorkspaceDragOverlay
                    sidebarProject={() => props.project}
                    activeWorkspace={props.ctx.activeWorkspace}
                    workspaceLabel={props.ctx.workspaceLabel}
                  />
                </DragOverlay>
              </DragDropProvider>
            </Show>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
