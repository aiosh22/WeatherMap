'use strict';

/* ==========================================================================
   WeatherMap - Asynchronous client-side SPA (Vanilla JS, ES6+)
   Map: Leaflet + OpenStreetMap | Geocoding: Nominatim | Weather: OpenWeatherMap
   ========================================================================== */

/* ---------- Configuration ---------- */
const CONFIG = {
  // Optional: paste keys here, or enter them in the "Settings" panel (saved in LocalStorage).
  OWM_API_KEY: '',
  OPENAI_API_KEY: '',
  DEFAULT_VIEW: { lat: 15.5007, lng: 32.5599, zoom: 6 }, // Khartoum, Sudan
  SEARCH_ZOOM: 10,
  OPENAI_MODEL: 'gpt-4o-mini',
};

const STORAGE = {
  favorites: 'weathermap:favorites',
  owmKey: 'weathermap:owmKey',
  openaiKey: 'weathermap:openaiKey',
};

/* ---------- DOM references ---------- */
const $ = (selector) => document.querySelector(selector);
const els = {
  form: $('#weather-form'),
  input: $('#location-input'),
  getBtn: $('#get-weather-btn'),
  favBtn: $('#fav-btn'),
  favList: $('#favorites-list'),
  alertBox: $('#alert-box'),
  spinner: $('#spinner'),
  forecast: $('#forecast'),
  forecastTitle: $('#forecast-title'),
  forecastGrid: $('#forecast-grid'),
  chatLog: $('#chat-log'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  chatSend: $('#chat-send'),
  settings: $('#settings'),
  settingsForm: $('#settings-form'),
  owmKey: $('#owm-key'),
  openaiKey: $('#openai-key'),
};

/* ---------- Application state ---------- */
let map = null;
let marker = null;          // only one marker lives on the map at a time
let current = null;        // last weather result (used by Share + chatbot)
let currentForecast = [];  // last 5-day forecast
const chatHistory = [];    // conversation sent to OpenAI

/* ---------- Small helpers ---------- */
class AppError extends Error {}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

const getKey = (name) => {
  const stored = localStorage.getItem(name === 'owm' ? STORAGE.owmKey : STORAGE.openaiKey);
  return (stored || (name === 'owm' ? CONFIG.OWM_API_KEY : CONFIG.OPENAI_API_KEY) || '').trim();
};

const iconUrl = (icon, size = '2x') => `https://openweathermap.org/img/wn/${icon}@${size}.png`;

/* ---------- Alerts & loading state ---------- */
function clearAlert() {
  els.alertBox.replaceChildren();
}

function showAlert(message, type = 'error') {
  const card = document.createElement('div');
  card.className = `alert alert--${type}`;
  card.setAttribute('role', 'alert');

  const text = document.createElement('div');
  text.className = 'alert__text';
  text.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'alert__close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '\u00D7';
  close.addEventListener('click', () => card.remove());

  card.append(text, close);
  els.alertBox.replaceChildren(card);

  if (type === 'success') setTimeout(() => card.remove(), 4000);
}

function setLoading(isLoading) {
  els.spinner.hidden = !isLoading;
  els.getBtn.disabled = isLoading;
}

/* ---------- Networking ---------- */
async function fetchJSON(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    throw new AppError('Network problem: please check your internet connection and try again.');
  }

  if (!response.ok) {
    if (response.status === 401) throw new AppError('Invalid or not-yet-activated API key (401). Please check your key in Settings.');
    if (response.status === 404) throw new AppError('The requested data was not found (404).');
    if (response.status === 429) throw new AppError('Too many requests (429). Please wait a moment and try again.');
    throw new AppError(`The server returned an error (${response.status}). Please try again later.`);
  }
  return response.json();
}

/* Phase 2: Asynchronous geocoding (OpenStreetMap Nominatim) */
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=en&q=${encodeURIComponent(query)}`;
  const results = await fetchJSON(url, { headers: { Accept: 'application/json' } });

  if (!Array.isArray(results) || results.length === 0) {
    throw new AppError(`We couldn't find "${query}". Check the spelling or try a nearby city.`);
  }
  const hit = results[0];
  return {
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
    name: hit.name || (hit.display_name || query).split(',')[0],
    country: hit.address && hit.address.country ? hit.address.country : '',
  };
}

/* Phase 3: OpenWeatherMap calls (chained after geocoding) */
const owmUrl = (endpoint, place) =>
  `https://api.openweathermap.org/data/2.5/${endpoint}?lat=${place.lat}&lon=${place.lng}&units=metric&appid=${encodeURIComponent(getKey('owm'))}`;

const fetchWeather = (place) => fetchJSON(owmUrl('weather', place));
const fetchForecast = (place) => fetchJSON(owmUrl('forecast', place));

function normalizeWeather(raw, place) {
  const w = raw.weather && raw.weather[0] ? raw.weather[0] : {};
  return {
    city: place.name || raw.name,
    country: place.country,
    lat: place.lat,
    lng: place.lng,
    temp: Math.round(raw.main.temp),
    feelsLike: Math.round(raw.main.feels_like),
    humidity: raw.main.humidity,
    wind: raw.wind ? raw.wind.speed : 0,
    clouds: raw.clouds ? raw.clouds.all : 0,
    description: w.description || '',
    icon: w.icon || '01d',
  };
}

/* Group the 3-hourly forecast into daily min/max cards */
function buildDailyForecast(raw) {
  const offset = raw.city && Number.isFinite(raw.city.timezone) ? raw.city.timezone : 0;
  const days = new Map();

  raw.list.forEach((item) => {
    const local = new Date((item.dt + offset) * 1000);   // shifted so UTC getters = local time
    const key = local.toISOString().slice(0, 10);
    const hour = local.getUTCHours();
    if (!days.has(key)) days.set(key, { key, min: Infinity, max: -Infinity, best: null, bestDiff: Infinity });
    const day = days.get(key);

    day.min = Math.min(day.min, item.main.temp_min);
    day.max = Math.max(day.max, item.main.temp_max);

    const diff = Math.abs(hour - 12);                    // use the slot closest to midday as the icon
    if (diff < day.bestDiff) {
      day.bestDiff = diff;
      day.best = item.weather[0];
    }
  });

  return [...days.values()].slice(0, 5).map((d) => ({
    key: d.key,
    min: Math.round(d.min),
    max: Math.round(d.max),
    icon: d.best.icon,
    description: d.best.description,
  }));
}

/* ---------- Map ---------- */
function initMap() {
  const { lat, lng, zoom } = CONFIG.DEFAULT_VIEW;               // Phase 1
  map = L.map('map').setView([lat, lng], zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // Hook the "Share" button inside every popup once it is opened (Phase 5)
  map.on('popupopen', (event) => {
    const popupEl = event.popup.getElement();
    const btn = popupEl && popupEl.querySelector('.share-btn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = 'true';
      btn.addEventListener('click', () => shareWeather(current));
    }
  });
}

function popupHtml(w) {
  const title = w.country ? `${w.city}, ${w.country}` : w.city;
  return `
    <div class="wx-card">
      <h2 class="wx-card__city">${escapeHtml(title)}</h2>
      <div class="wx-card__main">
        <img class="wx-card__icon" src="${iconUrl(w.icon)}" alt="${escapeHtml(w.description)}">
        <span class="wx-card__temp">${w.temp}<sup>&deg;C</sup></span>
      </div>
      <p class="wx-card__desc">${escapeHtml(w.description)}</p>
      <ul class="wx-card__meta">
        <li>Feels like: ${w.feelsLike}&deg;C</li>
        <li>Clouds: ${w.clouds}%</li>
        <li>Humidity: ${w.humidity}%</li>
        <li>Wind: ${w.wind} m/s</li>
      </ul>
      <button type="button" class="share-btn">Share</button>
    </div>`;
}

/* Phase 4 + 5: center map, replace marker, open InfoWindow */
function showOnMap(w) {
  if (marker) {                       // clear the previous marker from the map
    marker.remove();
    marker = null;
  }

  marker = L.marker([w.lat, w.lng])
    .addTo(map)
    .bindPopup(popupHtml(w), { className: 'wx-popup', minWidth: 230, maxWidth: 300 });

  let opened = false;
  const openPopup = () => {
    if (opened || !marker) return;
    opened = true;
    marker.openPopup();
  };

  map.flyTo([w.lat, w.lng], CONFIG.SEARCH_ZOOM, { duration: 1.5 });  // smooth animation
  map.once('moveend', openPopup);
  setTimeout(openPopup, 2200);        // safety net if no move happened
}

/* ---------- Bonus 1: Share ---------- */
function weatherMessage(w) {
  const place = w.country ? `${w.city}, ${w.country}` : w.city;
  return `Weather in ${place}: ${w.temp}\u00B0C, ${w.description}. ` +
         `Humidity ${w.humidity}%, wind ${w.wind} m/s, clouds ${w.clouds}%. (via WeatherMap)`;
}

async function shareWeather(w) {
  if (!w) return;
  const text = weatherMessage(w);

  if (navigator.share) {
    try {
      await navigator.share({ title: `Weather in ${w.city}`, text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // user closed the share sheet
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    showAlert('Weather message copied to the clipboard!', 'success');
  } catch (err) {
    const area = document.createElement('textarea');   // fallback for older browsers
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    showAlert(ok ? 'Weather message copied to the clipboard!' : 'Could not copy automatically. Please copy it manually: ' + text, ok ? 'success' : 'warning');
  }
}

/* ---------- Bonus 2: Favorites (LocalStorage) ---------- */
function loadFavorites() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE.favorites) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

const saveFavorites = (list) => localStorage.setItem(STORAGE.favorites, JSON.stringify(list));

function renderFavorites() {
  const favorites = loadFavorites();
  els.favList.replaceChildren();

  if (favorites.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'favorites__empty';
    empty.textContent = 'No favorites yet \u2013 search a city and press "Save".';
    els.favList.appendChild(empty);
  }

  favorites.forEach((name) => {
    const chip = document.createElement('span');
    chip.className = 'fav-chip';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'fav-chip__go';
    go.textContent = name;
    go.addEventListener('click', () => {
      els.input.value = name;
      searchWeather(name);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'fav-chip__remove';
    remove.setAttribute('aria-label', `Remove ${name} from favorites`);
    remove.textContent = '\u00D7';
    remove.addEventListener('click', () => {
      saveFavorites(loadFavorites().filter((n) => n !== name));
      renderFavorites();
      updateFavButton();
    });

    chip.append(go, remove);
    els.favList.appendChild(chip);
  });
}

function updateFavButton() {
  if (!current) {
    els.favBtn.disabled = true;
    return;
  }
  els.favBtn.disabled = false;
  els.favBtn.textContent = loadFavorites().includes(current.city) ? '\u2605 Saved' : '\u2606 Save';
}

function toggleFavorite() {
  if (!current) return;
  const favorites = loadFavorites();
  const next = favorites.includes(current.city)
    ? favorites.filter((n) => n !== current.city)
    : [...favorites, current.city];
  saveFavorites(next);
  renderFavorites();
  updateFavButton();
}

/* ---------- Bonus 3: 5-day forecast ---------- */
function renderForecast(days, cityName) {
  els.forecastGrid.replaceChildren();
  if (!days.length) {
    els.forecast.hidden = true;
    return;
  }
  els.forecastTitle.textContent = `5-Day Forecast \u2013 ${cityName}`;

  days.forEach((d) => {
    const date = new Date(`${d.key}T00:00:00Z`);
    const card = document.createElement('div');
    card.className = 'day-card';
    card.innerHTML = `
      <div class="day-card__name">${date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</div>
      <div class="day-card__date">${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</div>
      <img class="day-card__icon" src="${iconUrl(d.icon)}" alt="${escapeHtml(d.description)}">
      <div class="day-card__temps">${d.max}&deg; <span class="day-card__min">/ ${d.min}&deg;</span></div>
      <div class="day-card__desc">${escapeHtml(d.description)}</div>`;
    els.forecastGrid.appendChild(card);
  });
  els.forecast.hidden = false;
}

/* ---------- Main search flow ---------- */
async function searchWeather(rawQuery) {
  const query = rawQuery.trim();
  if (!query) {
    showAlert('Please type a location first (for example: Port Sudan).', 'warning');
    els.input.focus();
    return;
  }
  if (!getKey('owm')) {
    els.settings.open = true;
    showAlert('Please add your OpenWeatherMap API key in Settings first.', 'warning');
    els.owmKey.focus();
    return;
  }

  clearAlert();
  setLoading(true);
  try {
    const place = await geocode(query);                                   // Phase 2
    const [weatherRes, forecastRes] = await Promise.allSettled([          // Phase 3
      fetchWeather(place),
      fetchForecast(place),
    ]);

    if (weatherRes.status === 'rejected') throw weatherRes.reason;

    current = normalizeWeather(weatherRes.value, place);
    showOnMap(current);                                                   // Phases 4 + 5
    updateFavButton();

    if (forecastRes.status === 'fulfilled') {
      currentForecast = buildDailyForecast(forecastRes.value);
      renderForecast(currentForecast, current.city);
    } else {
      currentForecast = [];
      renderForecast([], current.city);
      showAlert('Current weather loaded, but the 5-day forecast is unavailable right now.', 'warning');
    }
  } catch (err) {
    showAlert(err instanceof AppError ? err.message : 'Something went wrong. Please try again.', 'error');
  } finally {
    setLoading(false);
  }
}

/* ---------- Bonus 4: AI chatbot (OpenAI) ---------- */
function addChatMessage(text, kind) {
  const msg = document.createElement('div');
  msg.className = `chat__msg chat__msg--${kind}`;
  msg.textContent = text;
  els.chatLog.appendChild(msg);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  return msg;
}

function chatContext() {
  if (!current) return 'No location has been searched yet.';
  const days = currentForecast
    .map((d) => `${d.key}: ${d.min}-${d.max}C, ${d.description}`)
    .join('; ');
  return `Current weather in ${current.city}${current.country ? ', ' + current.country : ''}: ` +
         `${current.temp}C (feels ${current.feelsLike}C), ${current.description}, humidity ${current.humidity}%, ` +
         `wind ${current.wind} m/s, clouds ${current.clouds}%.` + (days ? ` Forecast: ${days}.` : '');
}

/* Offline fallback: a small rule-based assistant that answers from the loaded weather data.
   Used automatically when there is no OpenAI key (or the OpenAI request fails). */
function localAnswer(question) {
  if (!current) return 'Please search for a city first, then ask me about its weather.';

  const q = question.toLowerCase();
  const has = (...words) => words.some((w) => q.includes(w));
  const desc = current.description.toLowerCase();
  const wet = (text) => /rain|drizzle|thunder|storm|shower/.test(text);
  const place = current.city;

  if (has('umbrella', 'rain', 'wet', 'شمسية', 'مطر', 'امطار')) {
    const soon = currentForecast.find((d) => wet(d.description.toLowerCase()));
    if (wet(desc)) return `Yes, take an umbrella \u2013 it is ${desc} in ${place} right now.`;
    if (soon) return `No rain right now in ${place}, but ${soon.description} is expected on ${soon.key}.`;
    return `No umbrella needed \u2013 no rain is expected in ${place} in the coming days.`;
  }
  if (has('wear', 'jacket', 'clothes', 'cold', 'ملابس', 'برد', 'جاكيت')) {
    if (current.temp >= 35) return `It is very hot (${current.temp}\u00B0C). Wear light, loose clothes and drink plenty of water.`;
    if (current.temp >= 25) return `It is warm (${current.temp}\u00B0C). Light clothes are fine.`;
    if (current.temp >= 15) return `It is mild (${current.temp}\u00B0C). A light jacket may be useful in the evening.`;
    return `It is cold (${current.temp}\u00B0C). Wear a warm jacket.`;
  }
  if (has('hot', 'temperature', 'temp', 'warm', 'حر', 'حرارة', 'درجة')) {
    return `It is ${current.temp}\u00B0C in ${place} (feels like ${current.feelsLike}\u00B0C), with ${desc}.`;
  }
  if (has('wind', 'رياح', 'هواء')) {
    const level = current.wind >= 10 ? 'strong' : current.wind >= 5 ? 'moderate' : 'light';
    return `The wind in ${place} is ${level}: ${current.wind} m/s.`;
  }
  if (has('humid', 'رطوبة')) return `Humidity in ${place} is ${current.humidity}%.`;
  if (has('cloud', 'sun', 'clear', 'غيوم', 'سحاب', 'شمس')) {
    return `Cloud cover in ${place} is ${current.clouds}% (${desc}).`;
  }
  if (has('forecast', 'tomorrow', 'week', 'days', 'غدا', 'بكرة', 'توقع')) {
    if (!currentForecast.length) return 'The forecast is not available right now.';
    return currentForecast.map((d) => `${d.key}: ${d.min}-${d.max}\u00B0C, ${d.description}`).join('\n');
  }
  return `${place}: ${current.temp}\u00B0C, ${desc}, humidity ${current.humidity}%, wind ${current.wind} m/s. ` +
         'Try asking about rain, clothes, wind, humidity or the forecast.';
}

async function askAssistant(question) {
  const key = getKey('openai');

  addChatMessage(question, 'user');

  if (!key) {                                  // no key -> offline assistant
    addChatMessage(localAnswer(question), 'bot');
    return;
  }

  chatHistory.push({ role: 'user', content: question });
  const typing = addChatMessage('Thinking\u2026', 'bot');
  typing.classList.add('chat__msg--typing');
  els.chatSend.disabled = true;

  try {
    const data = await fetchJSON('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: CONFIG.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a friendly weather assistant inside the WeatherMap app. ' +
                     'Answer weather-related questions briefly and clearly. ' + chatContext(),
          },
          ...chatHistory.slice(-10),
        ],
      }),
    });

    const answer = data.choices && data.choices[0] ? data.choices[0].message.content.trim() : '';
    typing.remove();
    addChatMessage(answer || 'Sorry, I could not come up with an answer.', 'bot');
    chatHistory.push({ role: 'assistant', content: answer });
  } catch (err) {
    typing.remove();
    chatHistory.pop();   // drop the unanswered question
    // OpenAI failed (no credit, bad key, offline...): fall back to the local assistant
    addChatMessage(localAnswer(question), 'bot');
    addChatMessage('(OpenAI is unavailable, so this answer came from the built-in assistant.)', 'error');
  } finally {
    els.chatSend.disabled = false;
    els.chatInput.focus();
  }
}

/* ---------- Settings ---------- */
function loadSettings() {
  els.owmKey.value = localStorage.getItem(STORAGE.owmKey) || '';
  els.openaiKey.value = localStorage.getItem(STORAGE.openaiKey) || '';
}

function saveSettings() {
  localStorage.setItem(STORAGE.owmKey, els.owmKey.value.trim());
  localStorage.setItem(STORAGE.openaiKey, els.openaiKey.value.trim());
  showAlert('API keys saved in this browser.', 'success');
}

/* ---------- Boot ---------- */
function init() {
  initMap();
  loadSettings();
  renderFavorites();
  updateFavButton();

  // No inline handlers: everything is wired with addEventListener
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();                 // no full page reload
    searchWeather(els.input.value);
  });

  els.favBtn.addEventListener('click', toggleFavorite);

  els.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = els.chatInput.value.trim();
    if (!question) return;
    els.chatInput.value = '';
    askAssistant(question);
  });

  els.settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveSettings();
  });
}

document.addEventListener('DOMContentLoaded', init);
