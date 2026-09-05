import { For, Show, type Accessor, type JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { type LocalProject } from "@/context/layout"

export const SidebarContent = (props: {
  mobile?: boolean
  projects: Accessor<LocalProject[]>
  renderProject: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  openProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  helpLabel: Accessor<string>
  onOpenHelp: () => void
  renderEmpty: () => JSX.Element
  renderFooter: () => JSX.Element
  setScrollRef: (el: HTMLDivElement | undefined) => void
}): JSX.Element => {
  const placement = () => (props.mobile ? "bottom" : "right")
  const openProjectLabel = () =>
    typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined

  return (
    <div class="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background-base">
      <div class="flex shrink-0 items-center gap-1 px-3 pt-3 pb-1">
        <div class="min-w-0 flex-1" />
        <Tooltip
          placement={placement()}
          value={
            <div class="flex items-center gap-2">
              <span>{props.openProjectLabel}</span>
              <Show when={!props.mobile && !!props.openProjectKeybind()}>
                <span class="text-icon-base text-12-medium">{props.openProjectKeybind()}</span>
              </Show>
            </div>
          }
        >
          <IconButton
            icon="folder-add-left"
            variant="ghost"
            class="size-7 rounded-md"
            onClick={props.onOpenProject}
            aria-label={openProjectLabel()}
          />
        </Tooltip>
        <TooltipKeybind placement={placement()} title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
          <IconButton
            icon="settings-gear"
            variant="ghost"
            class="size-7 rounded-md"
            onClick={props.onOpenSettings}
            aria-label={props.settingsLabel()}
          />
        </TooltipKeybind>
        <Tooltip placement={placement()} value={props.helpLabel()}>
          <IconButton
            icon="help"
            variant="ghost"
            class="size-7 rounded-md"
            onClick={props.onOpenHelp}
            aria-label={props.helpLabel()}
          />
        </Tooltip>
      </div>

      <Show
        when={props.projects().length > 0}
        fallback={<div class="flex min-h-0 flex-1 items-center justify-center">{props.renderEmpty()}</div>}
      >
        <DragDropProvider
          onDragStart={props.handleDragStart}
          onDragEnd={props.handleDragEnd}
          onDragOver={props.handleDragOver}
          collisionDetector={closestCenter}
        >
          <DragDropSensors />
          <ConstrainDragXAxis />
          <div
            ref={(el) => {
              if (!props.mobile) props.setScrollRef(el)
            }}
            class="min-h-0 flex-1 overflow-y-auto px-2 pb-2 no-scrollbar [overflow-anchor:none]"
          >
            <SortableProvider ids={props.projects().map((project) => project.worktree)}>
              <For each={props.projects()}>{(project) => props.renderProject(project)}</For>
            </SortableProvider>
          </div>
          <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
        </DragDropProvider>
      </Show>

      {props.renderFooter()}
    </div>
  )
}
