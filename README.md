# WeatherMap (SPA)

Files: index.html, style.css, app.js (separated, no inline handlers/styles, vanilla JS).

## Run
1. Get a free OpenWeatherMap API key (openweathermap.org). New keys can take up to ~2 hours to activate.
2. Open index.html in a browser (or use VS Code "Live Server").
3. Open "Settings", paste the key, press Save. (Optional: OpenAI key for the chatbot.)

## Features
- Phase 1-5: world map (Khartoum, zoom 6) -> Nominatim geocoding -> OpenWeatherMap -> animated centering + single marker -> popup with city, temp, clouds, humidity, wind, official icon, Share button.
- Bonus: Share (Web Share API / clipboard), Favorites (LocalStorage), 5-day forecast, OpenAI chatbot.
- UI: Roboto, title 2x body size, styled inputs, map = 70vh with navy border, CSS spinner, alert cards.

Chatbot: uses OpenAI when a key is saved, otherwise (or if OpenAI fails) a built-in rule-based assistant answers.

Note: the OpenAI key is stored in the browser, which is fine for a course project but not for production.
