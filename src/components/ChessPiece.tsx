import React from 'react';
import { color, type, type PieceCode } from '../game/chessEngine';

export const PieceDefs: React.FC = () => (
  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
    <defs>
      <g id="sh-p">
        <circle cx="22.5" cy="13.2" r="5.4" />
        <path d="M16 35C16.5 28 20.5 27 20.8 21H24.2C24.5 27 28.5 28 29 35Z" />
        <rect x="17.2" y="19" width="10.6" height="3.4" rx="1.7" />
        <path d="M12.5 40.5v-2.2c0-2 1.6-3.6 3.6-3.6h12.8c2 0 3.6 1.6 3.6 3.6v2.2z" />
      </g>
      <g id="sh-r">
        <path d="M12 9.5h5v3.5h3.5V9.5h4V13H28V9.5h5v10.5H12z" />
        <path d="M15 19h15l1.4 14.5H13.6z" />
        <path d="M10.5 40.5v-2.5c0-2.4 1.9-4.3 4.3-4.3h15.4c2.4 0 4.3 1.9 4.3 4.3v2.5z" />
      </g>
      <g id="sh-b">
        <circle cx="22.5" cy="8.6" r="2.9" />
        <path d="M22.5 11.6c6 3.3 8.2 7.4 8.2 11 0 3-2 4.8-2.6 7.2H16.9c-.6-2.4-2.6-4.2-2.6-7.2 0-3.6 2.2-7.7 8.2-11z" />
        <rect x="13.2" y="29.6" width="18.6" height="3.6" rx="1.8" />
        <path d="M16.5 33h12l2 3.4H14.5z" />
        <path d="M10.5 40.5v-2.3c0-1.8 1.4-3.2 3.2-3.2h17.6c1.8 0 3.2 1.4 3.2 3.2v2.3z" />
      </g>
      <g id="sh-n">
        <path d="M12 40.5C12 33.5 13.5 28.5 19 24.5 15.5 25 13 27 10.5 28.5 8.8 27.2 9.8 25.4 11 23.8 13.6 20.6 16.5 18.2 17.8 13.4L16.2 9.4 20.4 11C22.4 8.4 26.4 8.4 29 12 33.6 16.2 35.2 26 34.4 40.5Z" />
      </g>
      <g id="sh-q">
        <path d="M12.4 32L8 14.5 15 23 16 10.5 19.5 22 22.5 8.5 25.5 22 29 10.5 30 23 37 14.5 32.6 32Z" />
        <circle cx="8" cy="13.2" r="2.4" />
        <circle cx="16" cy="9.6" r="2.4" />
        <circle cx="22.5" cy="7.6" r="2.4" />
        <circle cx="29" cy="9.6" r="2.4" />
        <circle cx="37" cy="13.2" r="2.4" />
        <rect x="11" y="30.4" width="23" height="3.8" rx="1.9" />
        <path d="M10.5 40.5v-2.4c0-2.2 1.8-4 4-4h16c2.2 0 4 1.8 4 4v2.4z" />
      </g>
      <g id="sh-k">
        <rect x="21" y="3" width="3" height="11" />
        <rect x="17.8" y="6.4" width="9.4" height="3.2" />
        <path d="M22.5 14C27 11.5 36 13.5 35 22.4 34.4 26.8 31 28.4 30.6 31H14.4C14 28.4 10.6 26.8 10 22.4 9 13.5 18 11.5 22.5 14Z" />
        <rect x="12.6" y="30.2" width="19.8" height="3.8" rx="1.9" />
        <path d="M10.5 40.5v-2.4c0-2.2 1.8-4 4-4h16c2.2 0 4 1.8 4 4v2.4z" />
      </g>
      <g id="dt-b">
        <path d="M22.5 15.6v6.4M19.3 18.8h6.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </g>
      <g id="dt-n">
        <circle cx="20.8" cy="16.6" r="1.5" fill="currentColor" />
        <circle cx="11.7" cy="25.6" r="1" fill="currentColor" />
      </g>
      <g id="dt-r">
        <path d="M15.5 24.5h14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </g>
      <g id="dt-k">
        <path d="M16 24c4 2 9 2 13 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </g>
      <g id="dt-q">
        <path d="M16 24.5h13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </defs>
  </svg>
);

export const PieceSvg: React.FC<{
  code: PieceCode;
  className?: string;
  style?: React.CSSProperties;
}> = ({ code, className = '', style }) => {
  const t = type(code);
  const c = color(code);
  if (!t || !c) return null;
  return (
    <svg
      className={`pc pc-${c} ${className}`.trim()}
      viewBox="0 0 45 45"
      aria-hidden="true"
      style={style}
    >
      <g className="ol">
        <use href={`#sh-${t}`} />
      </g>
      <g className="fl">
        <use href={`#sh-${t}`} />
      </g>
      {t !== 'p' && (
        <g className="dt">
          <use href={`#dt-${t}`} />
        </g>
      )}
    </svg>
  );
};
