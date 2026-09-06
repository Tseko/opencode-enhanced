import { For, Show, createEffect, createMemo, startTransition } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Binary } from "@opencode-ai/core/util/binary"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useCommand } from "@/context/command"
import { getProjectAvatarVariant, type LocalProject, useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useSettingsCommand } from "@/components/settings-dialog"
import { displayName, errorMessage, getProjectAvatarSource, sortedRootSessions } from "@/pages/layout/helpers"
import { createHomeController, type HomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController, type HomeProjectsController } from "@/pages/home/home-projects-controller"
import { archiveHomeSession } from "@/pages/home-session-archive"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { showToast } from "@/utils/toast"
import type { Session } from "@opencode-ai/sdk/v2/client"

export function NewLayoutSidebarCommands() {
  const layout = useLayout()
  const language = useLanguage()
  const command = useCommand()
  command.register("layout", () => [
    {
      id: "sidebar.toggle",
      title: language.t("command.sidebar.toggle"),
      category: language.t("command.category.view"),
      keybind: "mod+b",
      onSelect: () => layout.sidebar.toggle(),
    },
  ])
  return null
}

export function NewLayoutSidebar() {
  const language = useLanguage()
  const platform = usePlatform()
  const tabs = useTabs()
  const params = useParams()
  const openSettings = useSettingsCommand()
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const [store, setStore] = persisted(
    Persist.global("layout.new-sidebar", ["layout.new-sidebar.v1"]),
    createStore({ expanded: {} as Record<string, boolean> }),
  )

  const server = () => home.server.focused()
  const list = () => projects.project.list()
  const sync = () => home.server.focusedSync()

  createEffect(() => {
    for (const project of list()) {
      void sync().project.loadSessions(project.worktree)
    }
  })

  const expanded = (worktree: string) => {
    const stored = store.expanded[worktree]
    if (stored !== undefined) return stored
    const selected = home.project.selected()
    if (selected) return pathKey(selected.worktree) === pathKey(worktree)
    return pathKey(list()[0]?.worktree ?? "") === pathKey(worktree)
  }

  const openSession = (session: Session) => {
    const conn = server()
    const ctx = home.server.focusedContext()
    if (!conn || !ctx) return
    ctx.projects.open(session.directory)
    ctx.projects.touch(session.directory)
    void startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      tabs.select(tab)
    })
  }

  const chooseProject = () => {
    const conn = server()
    if (!conn) return
    projects.project.choose(conn)
  }

  const archiveSession = async (session: Session) => {
    const conn = server()
    const ctx = home.server.focusedContext()
    if (!conn || !ctx) return
    const [, setStore] = ctx.sync.child(session.directory)
    if ((await ctx.sdk.protocol) !== "v1") return
    await archiveHomeSession({
      server: ServerConnection.key(conn),
      session,
      archive: (sessionID) =>
        ctx.sdk.client.session.update({
          sessionID,
          directory: session.directory,
          time: { archived: Date.now() },
        }),
      remove: () => {
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, session.id, (item) => item.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        )
        sync().homeSessions.remove(session.id)
      },
      onError: (cause) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(cause, language.t("common.requestFailed")),
        }),
    })
  }

  return (
    <nav
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
      data-component="sidebar-nav-desktop"
      class="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-v2-background-bg-deep"
    >
      <div class="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
        <div class="min-w-0 flex-1" />
        <TooltipV2 placement="right" value={language.t("command.project.open")}>
          <IconButtonV2
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="folder-add-left" />}
            onClick={chooseProject}
            aria-label={language.t("command.project.open")}
          />
        </TooltipV2>
        <TooltipV2 placement="right" value={language.t("sidebar.settings")}>
          <IconButtonV2
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="settings-gear" />}
            onClick={openSettings}
            aria-label={language.t("sidebar.settings")}
          />
        </TooltipV2>
        <TooltipV2 placement="right" value={language.t("sidebar.help")}>
          <IconButtonV2
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="help" />}
            onClick={() => platform.openExternal("https://opencode.ai/desktop-feedback")}
            aria-label={language.t("sidebar.help")}
          />
        </TooltipV2>
      </div>

      <Show
        when={list().length > 0}
        fallback={
          <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div class="text-14-medium text-v2-text-text-base">{language.t("sidebar.empty.title")}</div>
            <div class="text-14-regular text-v2-text-text-muted">{language.t("sidebar.empty.description")}</div>
            <button
              type="button"
              class="text-14-medium text-v2-text-text-base underline-offset-2 hover:underline"
              onClick={chooseProject}
            >
              {language.t("command.project.open")}
            </button>
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 no-scrollbar">
          <For each={list()}>
            {(project) => (
              <SidebarProject
                project={project}
                conn={server()}
                expanded={expanded(project.worktree)}
                selected={pathKey(home.project.selected()?.worktree ?? "") === pathKey(project.worktree)}
                activeSessionID={params.id}
                home={home}
                projects={projects}
                onToggle={() => setStore("expanded", project.worktree, !expanded(project.worktree))}
                onSelect={() => {
                  const conn = server()
                  if (!conn) return
                  setStore("expanded", project.worktree, true)
                  projects.project.select(conn, project.worktree)
                }}
                onOpenSession={openSession}
                onArchiveSession={archiveSession}
                language={language}
              />
            )}
          </For>
        </div>
      </Show>
    </nav>
  )
}

function SidebarProject(props: {
  project: LocalProject
  conn: ServerConnection.Any | undefined
  expanded: boolean
  selected: boolean
  activeSessionID: string | undefined
  home: HomeController
  projects: HomeProjectsController
  onToggle: () => void
  onSelect: () => void
  onOpenSession: (session: Session) => void
  onArchiveSession: (session: Session) => Promise<void>
  language: ReturnType<typeof useLanguage>
}) {
  const sessions = createMemo(() => {
    const [child] = props.home.server.focusedSync().child(props.project.worktree, { bootstrap: true })
    return sortedRootSessions(child, Date.now())
  })

  return (
    <div class="mb-1">
      <div class="group/project relative flex h-7 min-w-0 items-center rounded-[6px]">
        <button
          type="button"
          class="flex h-7 min-w-0 w-full items-center gap-1 rounded-[6px] px-1 text-left text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base"
          classList={{
            "bg-v2-background-bg-layer-03 text-v2-text-text-base": props.selected,
          }}
          onClick={props.onSelect}
        >
          <span
            class="flex size-5 shrink-0 items-center justify-center text-v2-icon-icon-muted"
            classList={{ "-rotate-90": !props.expanded }}
            onClick={(event) => {
              event.stopPropagation()
              props.onToggle()
            }}
          >
            <IconV2 name="chevron-down" />
          </span>
          <ProjectAvatar
            fallback={displayName(props.project)}
            src={getProjectAvatarSource(props.project.id, props.project.icon)}
            variant={getProjectAvatarVariant(props.project.icon?.color)}
          />
          <span class="min-w-0 flex-1 truncate text-[13px] [font-weight:440]">{displayName(props.project)}</span>
        </button>
        <Show when={props.conn}>
          {(conn) => (
            <div class="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 opacity-0 group-hover/project:pointer-events-auto group-hover/project:opacity-100">
              <TooltipV2 placement="top" value={props.language.t("command.session.new")}>
                <IconButtonV2
                  variant="ghost-muted"
                  size="small"
                  icon={<IconV2 name="plus" />}
                  aria-label={props.language.t("command.session.new")}
                  onClick={() => props.projects.project.openNewSession(conn(), props.project.worktree)}
                />
              </TooltipV2>
              <MenuV2 gutter={6} modal={false} placement="bottom-end">
                <MenuV2.Trigger
                  as={IconButtonV2}
                  variant="ghost-muted"
                  size="small"
                  icon={<IconV2 name="outline-dots" />}
                  aria-label={props.language.t("common.moreOptions")}
                />
                <MenuV2.Portal>
                  <MenuV2.Content>
                    <MenuV2.Item onSelect={() => props.projects.project.edit(conn(), props.project)}>
                      {props.language.t("dialog.project.edit.title")}
                    </MenuV2.Item>
                    <MenuV2.Item onSelect={() => props.projects.project.close(conn(), props.project.worktree)}>
                      {props.language.t("common.close")}
                    </MenuV2.Item>
                  </MenuV2.Content>
                </MenuV2.Portal>
              </MenuV2>
            </div>
          )}
        </Show>
      </div>
      <Show when={props.expanded}>
        <div class="flex flex-col py-0.5 pl-6">
          <For each={sessions()}>
            {(session) => (
              <SidebarSessionRow
                session={session}
                selected={props.activeSessionID === session.id}
                language={props.language}
                onOpen={() => props.onOpenSession(session)}
                onArchive={() => void props.onArchiveSession(session)}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function SidebarSessionRow(props: {
  session: Session
  selected: boolean
  language: ReturnType<typeof useLanguage>
  onOpen: () => void
  onArchive: () => void
}) {
  return (
    <div
      data-session-id={props.session.id}
      class="group/session relative flex h-7 min-w-0 w-full items-center gap-1 rounded-[6px] px-1.5 text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base"
      classList={{
        "bg-v2-background-bg-layer-03 text-v2-text-text-base": props.selected,
      }}
    >
      <button type="button" class="flex h-7 min-w-0 flex-1 items-center text-left" onClick={props.onOpen}>
        <span class="min-w-0 truncate text-[13px] [font-weight:440]">{sessionTitle(props.session.title)}</span>
      </button>
      <TooltipV2 placement="top" value={props.language.t("common.archive")}>
        <IconButtonV2
          data-action="sidebar-session-archive"
          variant="ghost-muted"
          size="small"
          icon={<IconV2 name="archive" />}
          aria-label={props.language.t("common.archive")}
          class="hover-reveal shrink-0 group-hover/session:opacity-100 focus-within:opacity-100"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.onArchive()
          }}
        />
      </TooltipV2>
      <span class="shrink-0 text-[11px] tabular-nums text-v2-text-text-muted">
        {getRelativeTime(props.session.time.updated ?? props.session.time.created, props.language.t)}
      </span>
    </div>
  )
}
