import type { Session } from "@opencode-ai/sdk/v2/client"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { getFilename } from "@opencode-ai/core/util/path"
import { A, useParams } from "@solidjs/router"
import { type Accessor, createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { childSessionOnPath, getProjectAvatarSource, hasProjectPermissions } from "./helpers"

export const ProjectIcon = (props: {
  project: LocalProject
  class?: string
  notify?: boolean
  working?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      return hasProjectPermissions(serverSync().session.data.permission, (item) => {
        if (serverSync().session.get(item.sessionID)?.directory !== directory) return false
        return !permission.autoResponds(item, directory)
      })
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))

  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={getProjectAvatarSource(props.project.id, props.project.icon)}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
      <Show when={props.working}>
        <div class="absolute bottom-px right-px size-3 rounded-full bg-background-base z-10 flex items-center justify-center">
          <Spinner class="size-[9px]" />
        </div>
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  sidebarExpanded: Accessor<boolean>
  sidebarHovering?: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
}

const SessionRow = (props: {
  session: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  warmPress: () => void
  warmFocus: () => void
  onOpen: () => void
  onRename: (title: string) => Promise<void>
}): JSX.Element => {
  const title = () => sessionTitle(props.session.title)

  return (
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center gap-2 min-w-0 w-full text-start focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
      onClick={() => {
        props.onOpen()
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <Show when={props.isWorking() || props.hasPermissions() || props.hasError() || props.unseenCount() > 0}>
        <div
          class="shrink-0 size-6 flex items-center justify-center"
          style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
        >
          <Switch>
            <Match when={props.isWorking()}>
              <Spinner class="size-[15px]" />
            </Match>
            <Match when={props.hasPermissions()}>
              <div class="size-1.5 rounded-full bg-surface-warning-strong" />
            </Match>
            <Match when={props.hasError()}>
              <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
            </Match>
            <Match when={props.unseenCount() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
      </Show>
      <SessionRename
        value={() => props.session.title ?? ""}
        displayValue={title}
        onSave={props.onRename}
        class="text-14-regular text-text-strong min-w-0 flex-1 truncate"
      />
    </A>
  )
}

export const SessionRename = (props: {
  value: Accessor<string>
  displayValue: Accessor<string | undefined>
  onSave: (title: string) => Promise<void>
  class?: string
}): JSX.Element => {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [pending, setPending] = createSignal(false)

  const open = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (pending()) return
    setDraft(props.value())
    setEditing(true)
  }

  const close = () => setEditing(false)
  const save = () => {
    if (!editing() || pending()) return
    const next = draft().trim()
    setEditing(false)
    if (!next || next === props.value()) return
    setPending(true)
    void props.onSave(next).finally(() => setPending(false))
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span class={props.class} onDblClick={open}>
          {props.displayValue()}
        </span>
      }
    >
      <InlineInput
        ref={(element) => {
          requestAnimationFrame(() => {
            if (!element.isConnected) return
            element.focus()
            element.select()
          })
        }}
        value={draft()}
        class={props.class}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Enter") {
            event.preventDefault()
            save()
            return
          }
          if (event.key === "Escape") {
            event.preventDefault()
            close()
          }
        }}
        onBlur={save}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDblClick={(event) => event.stopPropagation()}
      />
    </Show>
  )
}

function SessionMenuItems<T extends typeof DropdownMenu | typeof ContextMenu>(props: {
  Menu: T
  session: Session
  unread: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  onMarkRead: () => void
  onMarkUnread: () => void
  onArchive: () => void
}): JSX.Element {
  const Menu = props.Menu
  return (
    <>
      <Show
        when={props.unread()}
        fallback={
          <Menu.Item
            data-action="session-mark-unread"
            data-session={props.session.id}
            onSelect={props.onMarkUnread}
          >
            <Menu.ItemLabel>{props.language.t("sidebar.session.markAsUnread")}</Menu.ItemLabel>
          </Menu.Item>
        }
      >
        <Menu.Item data-action="session-mark-read" data-session={props.session.id} onSelect={props.onMarkRead}>
          <Menu.ItemLabel>{props.language.t("sidebar.session.markAsRead")}</Menu.ItemLabel>
        </Menu.Item>
      </Show>
      <Menu.Separator />
      <Menu.Item data-action="session-archive" data-session={props.session.id} onSelect={props.onArchive}>
        <Menu.ItemLabel>{props.language.t("common.archive")}</Menu.ItemLabel>
      </Menu.Item>
    </>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const layout = useLayout()
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = serverSync().child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(
      sessionStore.session,
      serverSync().session.data.permission,
      props.session.id,
      (item) => {
        return !permission.autoResponds(item, props.session.directory)
      },
    )
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return serverSync().session.data.session_working(props.session.id)
  })

  const tint = createMemo(() =>
    messageAgentColor(serverSync().session.data.message[props.session.id], sessionStore.agent),
  )
  const tooltip = createMemo(() => props.showTooltip ?? (props.mobile || !props.sidebarExpanded()))
  const currentChild = createMemo(() => {
    if (!props.showChild) return
    return childSessionOnPath(sessionStore.session, props.session.id, params.id)
  })

  const markRead = () => notification.session.markViewed(props.session.id)
  const rename = async (title: string) => {
    const original = props.session.title
    serverSync().session.remember({ ...props.session, title })
    try {
      await serverSDK().api.session.rename({ sessionID: props.session.id, title })
    } catch (error) {
      serverSync().session.remember({ ...props.session, title: original })
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      onOpen={markRead}
      onRename={rename}
    />
  )

  const [menuOpen, setMenuOpen] = createSignal(false)
  const unread = createMemo(() => unseenCount() > 0)
  const markUnread = () => notification.session.markUnread(props.session.id, props.session.directory)
  const archive = () => void props.archiveSession(props.session)

  return (
    <>
      <ContextMenu>
        <ContextMenu.Trigger
          as="div"
          data-session-id={props.session.id}
          class="group/session relative w-full min-w-0 rounded-md cursor-default pr-3 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
          style={{ "padding-inline-start": `${8 + (props.level ?? 0) * 16}px` }}
        >
          <Show when={isWorking()}>
            <div class="session-working-pulse absolute inset-0 rounded-md pointer-events-none" />
          </Show>
          <div class="flex min-w-0 items-center gap-1">
            <div class="min-w-0 flex-1">
              <Show
                when={!tooltip()}
                fallback={
                  <Tooltip
                    placement={props.mobile ? "bottom" : "right"}
                    value={sessionTitle(props.session.title)}
                    gutter={10}
                    class="min-w-0 w-full"
                  >
                    {item}
                  </Tooltip>
                }
              >
                {item}
              </Show>
            </div>

            <Show when={!props.level}>
              <div
                class="shrink-0 overflow-hidden transition-[width,opacity]"
                classList={{
                  "w-[50px] opacity-100 pointer-events-auto": !!props.mobile,
                  "w-0 opacity-0 pointer-events-none": !props.mobile,
                  "group-hover/session:w-[50px] group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
                  "group-focus-within/session:w-[50px] group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
                }}
              >
                <DropdownMenu
                  modal={!props.sidebarHovering?.()}
                  open={menuOpen()}
                  onOpenChange={(open) => setMenuOpen(open)}
                >
                  <Tooltip value={language.t("common.moreOptions")} placement="top">
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                      aria-label={language.t("common.moreOptions")}
                      data-action="session-menu"
                      data-session={props.session.id}
                    />
                  </Tooltip>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content>
                      <SessionMenuItems
                        Menu={DropdownMenu}
                        session={props.session}
                        unread={unread}
                        language={language}
                        onMarkRead={markRead}
                        onMarkUnread={markUnread}
                        onArchive={archive}
                      />
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
                <Tooltip value={language.t("common.archive")} placement="top">
                  <IconButton
                    icon="archive"
                    variant="ghost"
                    class="size-6 rounded-md"
                    aria-label={language.t("common.archive")}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void props.archiveSession(props.session)
                    }}
                  />
                </Tooltip>
              </div>
            </Show>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            <SessionMenuItems
              Menu={ContextMenu}
              session={props.session}
              unread={unread}
              language={language}
              onMarkRead={markRead}
              onMarkUnread={markUnread}
              onArchive={archive}
            />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
      <Show when={currentChild()} keyed>
        {(child) => (
          <div class="w-full">
            <SessionItem {...props} session={child} level={(props.level ?? 0) + 1} />
          </div>
        )}
      </Show>
    </>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center gap-2 min-w-0 w-full text-start focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <IconV2 name="edit" size="small" class="text-icon-weak" />
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{label}</span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
