/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/**/*.html", // For index.html and any other HTML in public
    "./public/**/*.js",   // If you add Tailwind classes via JavaScript in files within public
    
  ],
  theme: {
    extend: {
      fontFamily: { // To keep your Quicksand font
        quicksand: ['Quicksand', 'sans-serif'],
      },
      spacing: {
        10: '2.5rem',   
        12: '3rem',     
        16: '4rem',
      },
    },
  },
  plugins: [],
}
