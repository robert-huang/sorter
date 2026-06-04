interface Props {
  href: string;
  label: string;
  title?: string;
}

/** Fixed top-left link between Sorter and Anime to Anime. */
export function AppNavFab({ href, label, title }: Props) {
  return (
    <a className="app-nav-fab" href={href} title={title ?? label}>
      {label}
    </a>
  );
}
