/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/**/*.html", // For index.html and any other HTML in public
    "./public/**/*.js",   // If you add Tailwind classes via JavaScript in files within public
    // If your notifications.js is outside public but manipulates DOM with Tailwind classes, add its path too.
    // e.g., "./notifications.js" if it's in the root, or "./src/notifications.js" if in a src folder.
  ],
  theme: {
    extend: {
      fontFamily: { // To keep your Quicksand font
        quicksand: ['Quicksand', 'sans-serif'],
      },
      spacing: {
        10: '2.5rem',   // this adds gap-10 if it's missing
        12: '3rem',      // add other custom spacing values as needed
        16: '4rem',
      },
    },
  },
  plugins: [],
}