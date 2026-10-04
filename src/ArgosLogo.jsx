import React from "react";

/**
 * Official ARGOS Passage Logo Component
 * Faithfully reproduces the uploaded ARGOS Passage logo:
 * - Hemispherical polar globe base divided by curved latitude & meridian lines
 * - Central needle-sharp ship-bow / ice-passage spire rising through the center
 * - Glacial teal-cyan polar ocean basin (#2CA3BF) with undulating wave rim and 3 triangular icebergs
 * - Upper-right tilted planet Earth with orbital satellite ring
 * - Geometric wide-tracked "ARGOS" wordmark
 */
export default function ArgosLogo({
  size = 40,
  showWordmark = true,
  stacked = false,
  subtitle = "",
  className = "",
}) {
  return (
    <span
      className={`argos-brand-lockup ${
        stacked ? "is-stacked" : "is-inline"
      } ${className}`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 200 200"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="argos-logo-svg"
        aria-hidden="true"
      >
        {/* Subtle luminous badge backing so the dark navy hemisphere & negative-space grid lines match the official logo */}
        <rect
          x="6"
          y="6"
          width="188"
          height="188"
          rx="40"
          fill="#EAECEF"
          stroke="rgba(56, 189, 248, 0.45)"
          strokeWidth="4"
        />

        {/* Upper-Right Orbiting Planet Earth & Satellite Ring */}
        <g transform="translate(138, 50)">
          <ellipse
            cx="0"
            cy="0"
            rx="25"
            ry="10"
            transform="rotate(28)"
            stroke="#132535"
            strokeWidth="3.4"
            fill="none"
          />
          <circle
            cx="0"
            cy="0"
            r="13"
            fill="#EAECEF"
            stroke="#132535"
            strokeWidth="3.4"
          />
          {/* Continent Silhouettes */}
          <path
            d="M-5 -10 C-1 -8, 2 -4, -1 1 C-4 4, -2 8, -6 10 L-11 5 C-12 -1, -9 -8, -5 -10 Z"
            fill="#132535"
          />
          <path
            d="M5 -9 C9 -6, 12 -1, 10 5 C7 8, 4 6, 3 2 C2 -2, 3 -6, 5 -9 Z"
            fill="#132535"
          />
        </g>

        {/* Back Elliptical Rim of the Polar Bowl */}
        <path
          d="M 26 98 A 74 23 0 0 1 95 75"
          stroke="#132535"
          strokeWidth="3.6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M 105 75 A 74 23 0 0 1 174 98"
          stroke="#132535"
          strokeWidth="3.6"
          strokeLinecap="round"
          fill="none"
        />

        {/* Left Glacial Teal Ocean Basin with Undulating Wave Top */}
        <path
          d="M 26 98 C 37 86, 50 84, 60 90 C 70 96, 82 91, 94 88 C 89 107, 76 122, 55 133 C 40 125, 30 113, 26 98 Z"
          fill="#2CA3BF"
          stroke="#132535"
          strokeWidth="3.2"
          strokeLinejoin="round"
        />
        {/* Left Floating Triangular Icebergs */}
        <polygon points="30,98 40,90 50,98" fill="#132535" />
        <polygon points="56,99 67,91 78,99" fill="#132535" />

        {/* Right Glacial Teal Ocean Basin with Undulating Wave Top */}
        <path
          d="M 106 88 C 118 91, 130 96, 142 90 C 152 85, 164 87, 174 98 C 170 113, 160 125, 145 133 C 124 122, 111 107, 106 88 Z"
          fill="#2CA3BF"
          stroke="#132535"
          strokeWidth="3.2"
          strokeLinejoin="round"
        />
        {/* Right Floating Triangular Iceberg */}
        <polygon points="125,103 136,95 147,103" fill="#132535" />

        {/* Dark Navy Lower Hemisphere & Central Ship-Bow Spire */}
        <path
          d="M 26 100 C 28 142, 60 174, 100 174 C 140 174, 172 142, 174 100 C 162 118, 134 129, 106 86 L 100 18 L 94 86 C 66 129, 38 118, 26 100 Z"
          fill="#132535"
        />

        {/* Crisp Negative-Space Meridian, Latitude & Spire Curves */}
        <path
          d="M 100 20 C 96 92, 79 124, 45 149"
          stroke="#EAECEF"
          strokeWidth="4.6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M 100 20 C 104 92, 121 124, 155 149"
          stroke="#EAECEF"
          strokeWidth="4.6"
          strokeLinecap="round"
          fill="none"
        />
        <line
          x1="100"
          y1="52"
          x2="100"
          y2="175"
          stroke="#EAECEF"
          strokeWidth="4.8"
        />
        <path
          d="M 25 99 Q 100 147 175 99"
          stroke="#EAECEF"
          strokeWidth="4.8"
          fill="none"
        />
      </svg>

      {showWordmark && (
        <span className="argos-wordmark-group">
          <span className="argos-wordmark-text">ARGOS</span>
          {subtitle && <span className="argos-wordmark-sub">{subtitle}</span>}
        </span>
      )}
    </span>
  );
}
