interface Props {
  href: string;
  label: string;
  title?: string;
  /** Extra class names — e.g. `app-nav-link--tabs-row` in the Sorter tab strip. */
  className?: string;
}

/** Cross-app link between Sorter and Anime to Anime (inline in a header bar). */
export function AppNavFab({ href, label, title, className }: Props) {
  const classes = ['app-nav-link', className].filter(Boolean).join(' ');
  return (
    <a className={classes} href={href} title={title ?? label}>
      {label}
    </a>
  );
}
