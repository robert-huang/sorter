import type { ReactElement } from 'react';
import { toggleInArray } from '../lib/importers/anilist/filters';

export type ToolSegmentedOption<T extends string> = {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
};

export type ToolAnimeMangaMediaType = 'ANIME' | 'MANGA';

export const TOOL_ANIME_MANGA_MEDIA_TYPE_OPTIONS: readonly ToolSegmentedOption<ToolAnimeMangaMediaType>[] = [
  { value: 'ANIME', label: 'Anime' },
  { value: 'MANGA', label: 'Manga' },
];

type ToolSegmentedFilterCommonProps<T extends string> = {
  label?: string;
  labelId?: string;
  options: readonly ToolSegmentedOption<T>[];
  disabled?: boolean;
  /** Classes on the outer wrapper (labeled layout only). */
  className?: string;
  /** Classes on the inner `tool-segmented` element. */
  segmentedClassName?: string;
  /** Render only the segmented button group (no label row wrapper). */
  unlabeled?: boolean;
};

export type ToolSegmentedFilterProps<T extends string> = ToolSegmentedFilterCommonProps<T> &
  (
    | {
        /** Single-select: exactly one option is active at a time. */
        allowMultiple?: false;
        value: T;
        onChange: (value: T) => void;
      }
    | {
        /** Multi-select: toggle options independently (e.g. anime + manga lists). */
        allowMultiple: true;
        value: readonly T[];
        onChange: (value: T[]) => void;
      }
  );

/** Shared anime/manga media-type control (Stats single-select, Adaptation multi-select). */
export type ToolAnimeMangaMediaTypeFilterProps = {
  /** Row label; defaults to "Media". Adaptation Scores uses "Lists". */
  label?: string;
  disabled?: boolean;
  className?: string;
} &
  (
    | {
        allowMultiple?: false;
        value: ToolAnimeMangaMediaType;
        onChange: (value: ToolAnimeMangaMediaType) => void;
      }
    | {
        allowMultiple: true;
        value: readonly ToolAnimeMangaMediaType[];
        onChange: (value: ToolAnimeMangaMediaType[]) => void;
      }
  );

export function ToolAnimeMangaMediaTypeFilter(props: ToolAnimeMangaMediaTypeFilterProps): ReactElement {
  const { disabled, className, label = 'Media' } = props;
  if (props.allowMultiple) {
    return (
      <ToolSegmentedFilter
        label={label}
        options={TOOL_ANIME_MANGA_MEDIA_TYPE_OPTIONS}
        allowMultiple
        value={props.value}
        disabled={disabled}
        className={className}
        onChange={props.onChange}
      />
    );
  }
  return (
    <ToolSegmentedFilter
      label={label}
      options={TOOL_ANIME_MANGA_MEDIA_TYPE_OPTIONS}
      value={props.value}
      disabled={disabled}
      className={className}
      onChange={props.onChange}
    />
  );
}

/** Label + `tool-segmented` button group used across tool filter rows. */
export function ToolSegmentedFilter<T extends string>(props: ToolSegmentedFilterProps<T>): ReactElement {
  const {
    label,
    labelId,
    options,
    disabled = false,
    className,
    segmentedClassName,
    unlabeled = false,
  } = props;

  const resolvedLabelId =
    labelId ?? (label ? `tool-segmented-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);

  const handleOptionClick = (optionValue: T) => {
    if (props.allowMultiple) {
      props.onChange(toggleInArray([...props.value], optionValue));
      return;
    }
    props.onChange(optionValue);
  };

  const isOptionActive = (optionValue: T): boolean => {
    if (props.allowMultiple) {
      return props.value.includes(optionValue);
    }
    return props.value === optionValue;
  };

  const segmented = (
    <div
      className={['tool-segmented', segmentedClassName].filter(Boolean).join(' ')}
      role="group"
      aria-labelledby={resolvedLabelId}
    >
      {options.map((option) => {
        const active = isOptionActive(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={active ? 'active' : ''}
            aria-pressed={active}
            disabled={disabled || option.disabled}
            title={option.title}
            onClick={() => handleOptionClick(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );

  if (unlabeled) {
    return segmented;
  }

  return (
    <div className={['tool-field tool-field-label-row', className].filter(Boolean).join(' ')}>
      {label ? (
        <span className="tool-field-label" id={resolvedLabelId}>
          {label}
        </span>
      ) : null}
      {segmented}
    </div>
  );
}
