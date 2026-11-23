/**
 * DEV ONLY: the shared components on one stage, for the motion audit (capture.mjs drives it).
 *
 *   /dev-motion/motion.html?theme=walnutLight
 *
 * Each cell carries `data-cell` and its triggers `data-act`, so the capture script can press, hover and click them.
 * App modules load after the mock bridge (the theme reads persisted state at module scope).
 */
import { createSignal, type JSX } from 'solid-js';
import './motion.css';

async function boot(): Promise<void> {
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const [{ render }, store, theme, components, notice, shutdown, navRail, editedLines] = await Promise.all([
    import('solid-js/web'),
    import('../store'),
    import('../theme'),
    import('../components'),
    import('../components/Notice'),
    import('../components/ShutdownOverlay'),
    import('../shell/NavRail'),
    import('../motion/organic/EditedLines'),
  ]);
  const { Button, IconButton, Toggle, Select, Menu, Popover, TreeFolder, TreeItem, TooltipHost, tooltip } = components;
  const { Notice } = notice;
  const { ShutdownOverlay } = shutdown;
  const { NavRail } = navRail;
  const { EditedLines } = editedLines;
  theme.installTheme();
  store.connectStore();

  function Cell(props: { name: string; caption: string; children: JSX.Element }): JSX.Element {
    return (
      <section class="dm-cell" data-cell={props.name}>
        <span class="dm-caption type-caption">{props.caption}</span>
        {props.children}
      </section>
    );
  }

  function Stage(): JSX.Element {
    const [checked, setChecked] = createSignal(false);
    const [effort, setEffort] = createSignal('high');
    const [menuOpen, setMenuOpen] = createSignal(false);
    const [menuAnchor, setMenuAnchor] = createSignal<HTMLButtonElement>();
    const [popOpen, setPopOpen] = createSignal(false);
    const [popAnchor, setPopAnchor] = createSignal<HTMLButtonElement>();
    const [folderOpen, setFolderOpen] = createSignal(false);
    const [selected, setSelected] = createSignal('a');
    const notices = [
      { message: 'Codex lost its connection. Retrying in 5s.', tone: 'error' as const, action: { label: 'Retry now', run: () => {} } },
      { message: 'Claude is close to its weekly limit.', tone: 'warning' as const },
    ];
    const [noticeIndex, setNoticeIndex] = createSignal<number>();
    const [railRoute, setRailRoute] = createSignal('toolpacks');
    const [filesShown, setFilesShown] = createSignal(true);
    const railItems = [
      { id: 'chats', icon: 'chats' as const, label: 'Chats', visible: () => true },
      { id: 'files', icon: 'files' as const, label: 'Files', visible: filesShown },
      { id: 'knowledge', icon: 'knowledge' as const, label: 'Knowledge', visible: () => true },
      { id: 'toolpacks', icon: 'toolpacks' as const, label: 'Toolpacks', visible: () => true },
      { id: 'providers', icon: 'providers' as const, label: 'Providers', visible: () => true },
    ];
    const baseLines = [
      { id: 'l1', text: 'export function total(items) {' },
      { id: 'l2', text: '  let sum = 0;' },
      { id: 'l3', text: '  for (const item of items) sum += item;' },
      { id: 'l4', text: '  return sum;' },
      { id: 'l5', text: '}' },
    ];
    const editedCode = [
      baseLines[0],
      { id: 'n1', text: '  if (!items.length) return 0;' },
      { id: 'n2', text: '  return items.reduce((a, b) => a + b);' },
      baseLines[4],
    ];
    const [codeLines, setCodeLines] = createSignal(baseLines);

    return (
      <div class="dm-stage">
        <Cell name="buttons" caption="Button press">
          <div class="dm-row">
            <Button variant="primary" data-act="primary">Allow</Button>
            <Button variant="secondary" data-act="secondary">Cancel</Button>
            <Button variant="text" data-act="text">Text</Button>
          </div>
          <div class="dm-row">
            <IconButton icon="close" label="Close" data-act="icon" />
            <IconButton icon="check" label="Done" tooltipPlacement="bottom-start" data-act="tooltip" />
          </div>
        </Cell>

        <Cell name="toggle" caption="Toggle">
          <div class="dm-row">
            <Toggle checked={checked()} onChange={setChecked} label="Demo" />
            <span class="type-body">Reduce motion</span>
          </div>
        </Cell>

        <Cell name="select" caption="Select (opens upward)">
          <div class="dm-row dm-push">
            <Select
              value={effort()}
              onChange={setEffort}
              placement="top-start"
              options={[
                { value: 'low', label: 'low', hint: 'fastest', group: 'Effort' },
                { value: 'high', label: 'high' },
                { value: 'extra', label: 'extra high', hint: 'slowest' },
              ]}
            />
            <span class="type-caption dm-neighbour">neighbour</span>
          </div>
        </Cell>

        <Cell name="menu" caption="Menu">
          <div class="dm-row">
            <Button variant="secondary" ref={setMenuAnchor} data-act="menu" aria-expanded={menuOpen()} onClick={() => setMenuOpen(!menuOpen())}>
              Actions
            </Button>
          </div>
          <Menu
            anchor={menuAnchor()}
            open={menuOpen()}
            onClose={() => setMenuOpen(false)}
            onSelect={() => {}}
            items={[
              { kind: 'group', label: 'Chat' },
              { id: 'rename', label: 'Rename', icon: 'edit', hint: 'F2' },
              { id: 'fork', label: 'Fork' },
              { kind: 'separator' },
              { id: 'delete', label: 'Delete', danger: true },
            ]}
          />
        </Cell>

        <Cell name="popover" caption="Popover (bottom-end)">
          <div class="dm-row" style={{ 'justify-content': 'flex-end' }}>
            <Button variant="secondary" ref={setPopAnchor} data-act="popover" onClick={() => setPopOpen(!popOpen())}>
              Details
            </Button>
          </div>
          <Popover anchor={popAnchor()} open={popOpen()} onClose={() => setPopOpen(false)} placement="bottom-end">
            <div class="dm-popover-body type-body">A raised surface that grows from the corner of its trigger.</div>
          </Popover>
        </Cell>

        <Cell name="tree" caption="Tree">
          <TreeFolder label="Unify" icon="folder" trailing="3 chats" open={folderOpen()} onToggle={setFolderOpen}>
            <TreeItem label="Fix ACP init timeout" trailing="0:42" selected={selected() === 'a'} onClick={() => setSelected('a')} />
            <TreeItem label="Polish motion" trailing="2:10" selected={selected() === 'b'} onClick={() => setSelected('b')} />
            <TreeItem label="Hub publishing" trailing="1d" selected={selected() === 'c'} onClick={() => setSelected('c')} />
          </TreeFolder>
          <TreeItem label="Below the folder" trailing="moves" />
        </Cell>

        <Cell name="notice" caption="Notice">
          <div class="dm-row">
            <Button variant="secondary" data-act="notice" onClick={() => setNoticeIndex(index => (index === undefined ? 0 : (index + 1) % notices.length))}>
              Next notice
            </Button>
            <Button variant="text" data-act="notice-clear" onClick={() => setNoticeIndex(undefined)}>
              Clear
            </Button>
          </div>
          <div class="dm-notice">
            <Notice notice={noticeIndex() === undefined ? undefined : notices[noticeIndex()!]} onDismiss={() => setNoticeIndex(undefined)} />
          </div>
        </Cell>

        <Cell name="shutdown" caption="Shutdown overlay">
          <div class="dm-shutdown">
            <div class="dm-shutdown-content type-body">Content under the scrim.</div>
            <ShutdownOverlay />
          </div>
        </Cell>

        <Cell name="tooltip-target" caption="Tooltip on a plain element">
          <div class="dm-row">
            <span class="dm-chip type-caption" ref={element => tooltip(element, 'Plain tooltip')} data-act="chip">
              hover me
            </span>
          </div>
        </Cell>

        <Cell name="edited-lines" caption="Edited lines (organic code edit)">
          <div class="dm-row">
            <Button variant="secondary" data-act="code-edit" onClick={() => setCodeLines(editedCode)}>
              Edit
            </Button>
            <Button variant="text" data-act="code-reset" onClick={() => setCodeLines(baseLines)}>
              Reset
            </Button>
          </div>
          <div class="dm-code type-mono">
            <EditedLines each={codeLines()} key={line => line.id} lineClass="dm-code-line">
              {line => <span>{line().text}</span>}
            </EditedLines>
          </div>
        </Cell>

        <Cell name="nav-rail" caption="Nav rail">
          <div class="dm-row">
            <Button variant="secondary" data-act="rail-files" onClick={() => setFilesShown(!filesShown())}>
              Toggle Files
            </Button>
          </div>
          <div class="dm-rail">
            <NavRail
              items={railItems}
              active={railRoute()}
              onSelect={setRailRoute}
              onSettings={() => {}}
              showMeter
            />
          </div>
        </Cell>
        <TooltipHost />
      </div>
    );
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  render(() => <Stage />, root);
}

void boot();
