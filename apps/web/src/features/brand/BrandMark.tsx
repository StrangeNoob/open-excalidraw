/**
 * The product mark: a sword-hilted pen nib laying down a stroke.
 *
 * Filled with `currentColor` rather than a hard-coded violet, so one file
 * serves the light and dark schemes and any accent the caller sets. The
 * source assets and their usage rules live in docs/brand.
 */
export const BrandMark = ({
  className,
  size = 40,
  title,
}: {
  className?: string;
  size?: number;
  title?: string;
}) => (
  <svg
    aria-hidden={title ? undefined : true}
    className={className}
    fill="currentColor"
    height={size}
    role={title ? "img" : undefined}
    viewBox="0 0 100 100"
    width={size}
    {...(title ? { "aria-label": title } : {})}
  >
    <g transform="translate(-1.5 3.5)">
      <g transform="rotate(-18 50 50)">
        <circle cx="50" cy="11" r="5" />
        <rect x="46" y="15" width="8" height="7.5" rx="2" />
        <path d="M30 22 L70 22 Q75 22 75 26.5 Q75 31 70 31 L30 31 Q25 31 25 26.5 Q25 22 30 22 Z" />
        <path
          fillRule="evenodd"
          d="M43 33 L57 33 L60 52 L50 72 L40 52 Z M49 55 L51 55 L50.4 69 L49.6 69 Z M52.6 53 a2.6 2.6 0 1 0 -5.2 0 a2.6 2.6 0 1 0 5.2 0 Z"
        />
      </g>
      <path
        d="M56 71 Q68 81 84 73"
        fill="none"
        stroke="currentColor"
        strokeWidth="9.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
);
