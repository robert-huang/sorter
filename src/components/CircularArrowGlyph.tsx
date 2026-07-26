type CircularArrowGlyphProps = {
  direction?: 'clockwise' | 'counterclockwise';
};

/** Filled circular arrow cropped to its painted bounds for true visual centering. */
export function CircularArrowGlyph({
  direction = 'clockwise',
}: CircularArrowGlyphProps) {
  const isClockwise = direction === 'clockwise';

  return (
    <svg
      className="icon-btn-glyph circular-arrow-glyph"
      width="1em"
      height="1em"
      viewBox="-3 -3 178.461 215.766"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M86.2305 209.766C133.887 209.766 172.461 171.191 172.461 123.535C172.461 75.8789 133.887 37.3047 86.2305 37.3047C75.8789 37.3047 65.8203 39.1602 56.8359 42.5781C54.1992 43.5547 50.4883 45.4102 50.5859 50.3906C50.6836 56.4453 56.6406 59.2773 61.6211 57.3242C69.3359 54.4922 77.6367 52.9297 86.2305 52.9297C125.195 52.9297 156.738 84.4727 156.738 123.438C156.738 162.402 125.195 193.945 86.2305 193.945C47.2656 193.945 15.7227 162.402 15.7227 123.438C15.7227 119.141 12.207 115.625 7.8125 115.625C3.51562 115.625 0 119.141 0 123.438C0 171.191 38.5742 209.766 86.2305 209.766ZM59.7656 49.0234L95.4102 13.6719C96.875 12.207 97.5586 10.0586 97.5586 8.00781C97.5586 3.61328 94.2383 0 89.8438 0C87.5 0 85.6445 0.976562 84.1797 2.44141L43.9453 43.2617C42.3828 44.8242 41.5039 46.9727 41.5039 49.1211C41.5039 51.2695 42.1875 53.2227 43.9453 54.9805L84.1797 95.4102C85.6445 96.7773 87.4023 97.6562 89.8438 97.6562C94.2383 97.6562 97.5586 94.2383 97.5586 89.7461C97.5586 87.6953 96.875 85.7422 95.3125 84.2773Z"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinejoin="round"
        paintOrder="stroke fill"
        transform={isClockwise ? 'translate(172.461 0) scale(-1 1)' : undefined}
      />
    </svg>
  );
}
