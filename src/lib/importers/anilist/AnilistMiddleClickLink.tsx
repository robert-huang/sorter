import type {
  AnchorHTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from 'react';
import {
  bindAnilistMiddleClick,
  composeAnilistLinkClick,
  mergeAnilistLinkClass,
} from './anilistLinks';

type AnilistMiddleClickLinkProps = {
  url: string | readonly string[] | null;
  className?: string;
  children: ReactNode;
  /**
   * Custom left-click handler. Ctrl/cmd/shift/alt-click still follow `href`.
   * When omitted, plain left-click does not navigate.
   */
  onPrimaryClick?: (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>
  ) => void;
  /** Preserve a shift-based primary action instead of opening a new window. */
  allowShiftPrimaryClick?: boolean;
} & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href' | 'onClick' | 'children' | 'className'
>;

/**
 * Anchor wrapper for AniList middle-click targets. Supplies `href` for the
 * native link context menu while preserving custom left-click actions.
 */
export function AnilistMiddleClickLink({
  url,
  className,
  children,
  onPrimaryClick,
  allowShiftPrimaryClick = false,
  onKeyDown,
  ...rest
}: AnilistMiddleClickLinkProps) {
  const link = bindAnilistMiddleClick(url);
  if (!link.href) {
    return (
      <span
        className={className}
        onClick={onPrimaryClick}
        onKeyDown={onKeyDown}
        {...rest}
      >
        {children}
      </span>
    );
  }

  return (
    <a
      href={link.href}
      className={mergeAnilistLinkClass(className ?? '', link.className)}
      rel="noopener noreferrer"
      onMouseDown={link.onMouseDown}
      onAuxClick={link.onAuxClick}
      onClick={composeAnilistLinkClick(onPrimaryClick, {
        allowShiftKey: allowShiftPrimaryClick,
      })}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          event.key === ' ' &&
          onPrimaryClick
        ) {
          event.preventDefault();
          onPrimaryClick(event);
        }
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
