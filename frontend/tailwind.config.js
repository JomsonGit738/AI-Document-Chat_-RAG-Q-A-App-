/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,ts}"],
  theme: {
    extend: {
      boxShadow: {
        glow: "0 0 0 1px rgba(99, 102, 241, 0.25), 0 0 30px rgba(99, 102, 241, 0.18)"
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"]
      },
      keyframes: {
        pulseBorder: {
          "0%, 100%": { boxShadow: "0 0 0 1px rgba(99, 102, 241, 0.18)" },
          "50%": { boxShadow: "0 0 0 1px rgba(99, 102, 241, 0.5), 0 0 28px rgba(99, 102, 241, 0.24)" }
        },
        cursorBlink: {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" }
        },
        floatUp: {
          "0%": { transform: "translateY(4px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" }
        }
      },
      animation: {
        "pulse-border": "pulseBorder 1.8s ease-in-out infinite",
        cursor: "cursorBlink 1s steps(1) infinite",
        "float-up": "floatUp 0.15s ease-out"
      }
    }
  },
  plugins: []
};

