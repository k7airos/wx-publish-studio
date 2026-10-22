/** 兔狲（Pallas's cat）极简标志：宽扁脸、低侧小耳、两侧腮毛、半睁眼。脸用 currentColor，五官取 --logo-ink（默认与底块同色）。 */
export function Logo({ size = 30 }: { size?: number }) {
  return <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="6 20 52 36" width={size * 0.78} height={size * 0.54}>
      <g fill="currentColor">
        <circle cx="12.5" cy="31.5" r="4.6" /><circle cx="51.5" cy="31.5" r="4.6" />
        <path d="M9 38C9 27.5 18.5 22 32 22S55 27.5 55 38C55 40.8 54 43.2 52.2 45.3L57 49.2L49.6 48.4C45.6 51.4 39.2 53 32 53S18.4 51.4 14.4 48.4L7 49.2L11.8 45.3C10 43.2 9 40.8 9 38Z" />
      </g>
      <g style={{ fill: "var(--logo-ink)" }}>
        <path d="M18.5 35.5h10a5 5 0 0 1-10 0Z" /><path d="M35.5 35.5h10a5 5 0 0 1-10 0Z" />
        <path d="M29.8 42.5h4.4L32 45z" />
      </g>
    </svg>
  </span>;
}

export const PRODUCT = { name: "兔狲", tagline: "公众号助手" };
