/** Width of the vertical scrollbar inside a scroll container (0 when not shown). */
export function chartScrollGutterWidth(scrollEl: HTMLElement): number {
  return Math.max(0, scrollEl.offsetWidth - scrollEl.clientWidth);
}

/** Pad the pinned header so its content width matches the scroll body's client area. */
export function applyHeaderScrollbarGutter(
  headerWrap: HTMLElement,
  bodyScroll: HTMLElement,
): void {
  headerWrap.style.paddingRight = `${chartScrollGutterWidth(bodyScroll)}px`;
}

function clearColumnWidths(
  table: HTMLTableElement,
  columnClasses: readonly string[],
): void {
  table.style.width = '';
  for (const cls of columnClasses) {
    for (const cell of table.querySelectorAll(`.${cls}`)) {
      const el = cell as HTMLElement;
      el.style.width = '';
      el.style.minWidth = '';
      el.style.maxWidth = '';
    }
  }
}

function measureColumnWidths(
  bodyTable: HTMLTableElement,
  columnClasses: readonly string[],
  headerTable: HTMLTableElement,
): Map<string, number> {
  const widths = new Map<string, number>();

  for (const cls of columnClasses) {
    let max = 0;
    for (const cell of bodyTable.querySelectorAll(`tbody .${cls}`)) {
      const el = cell as HTMLElement;
      if (el.getAttribute('aria-hidden') === 'true') {
        continue;
      }
      max = Math.max(max, el.getBoundingClientRect().width);
    }
    const headerCell = headerTable.querySelector(`thead .${cls}`) as HTMLElement | null;
    if (headerCell) {
      max = Math.max(max, headerCell.getBoundingClientRect().width);
    }
    if (max > 0) {
      widths.set(cls, Math.ceil(max));
    }
  }

  return widths;
}

function applyColumnWidths(
  table: HTMLTableElement,
  widths: ReadonlyMap<string, number>,
): void {
  for (const [cls, width] of widths) {
    const widthPx = `${width}px`;
    for (const cell of table.querySelectorAll(`.${cls}`)) {
      const el = cell as HTMLElement;
      el.style.width = widthPx;
      el.style.minWidth = widthPx;
      el.style.maxWidth = widthPx;
    }
  }
}

/** Match one column's width across header/body split tables (header + body content). */
export function syncPairedTableColumnWidth(
  headerTable: HTMLTableElement,
  bodyTable: HTMLTableElement,
  columnClass: string,
): void {
  for (const table of [headerTable, bodyTable]) {
    for (const cell of table.querySelectorAll(`.${columnClass}`)) {
      const el = cell as HTMLElement;
      el.style.width = '';
      el.style.minWidth = '';
      el.style.maxWidth = '';
    }
  }

  let maxWidth = 0;
  const headerCell = headerTable.querySelector(`thead .${columnClass}`) as HTMLElement | null;
  if (headerCell) {
    maxWidth = Math.max(maxWidth, headerCell.getBoundingClientRect().width);
  }
  for (const cell of bodyTable.querySelectorAll(`tbody .${columnClass}`)) {
    const el = cell as HTMLElement;
    if (el.getAttribute('aria-hidden') === 'true') {
      continue;
    }
    maxWidth = Math.max(maxWidth, el.getBoundingClientRect().width);
  }

  if (maxWidth <= 0) {
    return;
  }

  const widthPx = `${Math.ceil(maxWidth)}px`;
  for (const table of [headerTable, bodyTable]) {
    for (const cell of table.querySelectorAll(`.${columnClass}`)) {
      const el = cell as HTMLElement;
      el.style.width = widthPx;
      el.style.minWidth = widthPx;
      el.style.maxWidth = widthPx;
    }
  }
}

/** Match header/body column widths from body content (class per logical column). */
export function syncTableColumnsByClass(
  headerTable: HTMLTableElement,
  bodyTable: HTMLTableElement,
  columnClasses: readonly string[],
  columnMinWidths?: Readonly<Record<string, number>>,
  options?: { setTableWidth?: boolean },
): void {
  clearColumnWidths(headerTable, columnClasses);
  clearColumnWidths(bodyTable, columnClasses);

  const widths = measureColumnWidths(bodyTable, columnClasses, headerTable);
  for (const cls of columnClasses) {
    const min = columnMinWidths?.[cls] ?? 0;
    const measured = widths.get(cls) ?? 0;
    if (measured > 0 || min > 0) {
      widths.set(cls, Math.max(measured, min));
    }
  }
  applyColumnWidths(headerTable, widths);
  applyColumnWidths(bodyTable, widths);

  if (options?.setTableWidth === false) {
    return;
  }

  let total = 0;
  for (const cls of columnClasses) {
    total += widths.get(cls) ?? 0;
  }
  if (total > 0) {
    const tableWidth = `${total}px`;
    headerTable.style.width = tableWidth;
    bodyTable.style.width = tableWidth;
  }
}

function clearIndexWidths(table: HTMLTableElement): void {
  table.style.width = '';
  for (const cell of table.querySelectorAll('thead th, tbody td, tbody th')) {
    const el = cell as HTMLElement;
    el.style.width = '';
    el.style.minWidth = '';
    el.style.maxWidth = '';
  }
}

/** Match header/body column widths by column index (staff compare tables). */
export function syncTableColumnsByIndex(
  headerTable: HTMLTableElement,
  bodyTable: HTMLTableElement,
): void {
  clearIndexWidths(headerTable);
  clearIndexWidths(bodyTable);

  const headerCells = Array.from(headerTable.querySelectorAll('thead th')) as HTMLElement[];
  const bodyRows = Array.from(bodyTable.querySelectorAll('tbody tr'));
  if (headerCells.length === 0) {
    return;
  }

  const widths: number[] = headerCells.map((cell) => Math.ceil(cell.getBoundingClientRect().width));
  for (const row of bodyRows) {
    const cells = Array.from(row.children) as HTMLElement[];
    for (let index = 0; index < cells.length; index += 1) {
      widths[index] = Math.max(widths[index] ?? 0, Math.ceil(cells[index]!.getBoundingClientRect().width));
    }
  }

  let total = 0;
  for (let index = 0; index < headerCells.length; index += 1) {
    const width = widths[index] ?? 0;
    if (width <= 0) {
      continue;
    }
    total += width;
    const widthPx = `${width}px`;
    headerCells[index]!.style.width = widthPx;
    headerCells[index]!.style.minWidth = widthPx;
    headerCells[index]!.style.maxWidth = widthPx;
    for (const row of bodyRows) {
      const cell = row.children[index] as HTMLElement | undefined;
      if (!cell) {
        continue;
      }
      cell.style.width = widthPx;
      cell.style.minWidth = widthPx;
      cell.style.maxWidth = widthPx;
    }
  }

  if (total > 0) {
    const tableWidth = `${total}px`;
    headerTable.style.width = tableWidth;
    bodyTable.style.width = tableWidth;
  }
}
