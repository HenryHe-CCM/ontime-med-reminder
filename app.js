(() => {
  'use strict';

  const STORAGE_KEY = 'ontime.medication.v1';
  const ALERTS_KEY = 'ontime.alerts.v1';
  const SCHEMA_VERSION = 1;
  const MAX_TIMES = 6;
  const MAX_MEDS = 100;
  const ALERT_WINDOW_MS = 30 * 60 * 1000;
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const WEEKDAYS_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
  const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  const FREQUENCIES = {
    qd: { label: '每日一次', short: 'qd', defaults: ['08:00'] },
    bid: { label: '每日两次', short: 'bid', defaults: ['08:00', '20:00'] },
    tid: { label: '每日三次', short: 'tid', defaults: ['08:00', '12:00', '18:00'] },
    qid: { label: '每日四次', short: 'qid', defaults: ['08:00', '12:00', '18:00', '22:00'] },
    q8h: { label: '每 8 小时', short: 'q8h', defaults: ['06:00', '14:00', '22:00'] },
    q12h: { label: '每 12 小时', short: 'q12h', defaults: ['08:00', '20:00'] },
    custom: { label: '自定义', short: '自定', defaults: null }
  };

  const COLORS = new Set(['teal', 'amber', 'blue', 'rose']);
  const APP_ICON = './icons/icon-192.png';

  let state = createDefaultState();
  let currentView = 'today';
  let editingMedId = null;
  let toastTimer = null;
  let audioContext = null;
  let lastDayKey = '';
  let notificationRequestInFlight = false;
  let pendingCalendar = null;
  let els = {};

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  function init() {
    cacheElements();
    state = loadState();
    lastDayKey = todayKey();
    bindEvents();
    renderAll();
    registerServiceWorker();
    window.setInterval(tick, 20000);
    window.setTimeout(() => scanDueReminders(), 900);
  }

  /* ---------------------------------------------------------------------
     State
     --------------------------------------------------------------------- */

  function createDefaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      meds: [],
      intakes: {},
      settings: {
        sound: true,
        calendarDirty: true,
        calendarHintDismissed: false,
        lastCalendarExport: null
      }
    };
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function normalizeState(raw, options = {}) {
    const strict = options.strict === true;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (strict) throw new Error('备份文件的结构不正确。');
      return createDefaultState();
    }

    if (strict && (!Array.isArray(raw.meds) || !raw.intakes || typeof raw.intakes !== 'object')) {
      throw new Error('备份文件缺少药物或记录数据。');
    }

    const base = createDefaultState();
    const seenIds = new Set();
    const meds = [];

    (Array.isArray(raw.meds) ? raw.meds : []).slice(0, MAX_MEDS).forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const name = cleanText(item.name, 60);
      if (!name) return;

      let id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(item.id)
        ? item.id
        : makeId();
      if (seenIds.has(id)) id = makeId();
      seenIds.add(id);

      const times = [...new Set(
        (Array.isArray(item.times) ? item.times : [])
          .filter((time) => typeof time === 'string' && TIME_PATTERN.test(time))
      )].sort().slice(0, MAX_TIMES);
      if (!times.length) times.push('08:00');

      let startDate = DATE_PATTERN.test(String(item.startDate || '')) ? item.startDate : todayKey();
      let endDate = DATE_PATTERN.test(String(item.endDate || '')) ? item.endDate : null;
      if (endDate && endDate < startDate) endDate = null;

      const frequency = Object.prototype.hasOwnProperty.call(FREQUENCIES, item.frequency)
        ? item.frequency
        : 'custom';

      const createdAt = isValidDateString(item.createdAt)
        ? new Date(item.createdAt).toISOString()
        : new Date().toISOString();

      meds.push({
        id,
        name,
        dose: cleanText(item.dose, 80) || '未填写用量',
        times,
        frequency,
        startDate,
        endDate,
        note: cleanText(item.note, 200),
        color: COLORS.has(item.color) ? item.color : 'teal',
        active: item.active !== false,
        createdAt
      });
    });

    const intakes = {};
    const rawIntakes = raw.intakes && typeof raw.intakes === 'object' ? raw.intakes : {};
    Object.keys(rawIntakes).forEach((date) => {
      if (!DATE_PATTERN.test(date)) return;
      const day = rawIntakes[date];
      if (!day || typeof day !== 'object' || Array.isArray(day)) return;
      const cleanDay = {};
      Object.keys(day).forEach((key) => {
        const entry = day[key];
        if (!entry || typeof entry !== 'object') return;
        if (entry.status !== 'taken') return;
        if (!key.includes('::')) return;
        cleanDay[key] = {
          status: 'taken',
          at: isValidDateString(entry.at) ? new Date(entry.at).toISOString() : new Date().toISOString(),
          medName: cleanText(entry.medName, 60),
          dose: cleanText(entry.dose, 80),
          scheduled: TIME_PATTERN.test(String(entry.scheduled || '')) ? entry.scheduled : ''
        };
      });
      if (Object.keys(cleanDay).length) intakes[date] = cleanDay;
    });

    const rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    const lastExport = isValidDateString(rawSettings.lastCalendarExport)
      ? new Date(rawSettings.lastCalendarExport).toISOString()
      : null;

    return {
      schemaVersion: SCHEMA_VERSION,
      meds,
      intakes,
      settings: {
        sound: rawSettings.sound !== false,
        calendarDirty: typeof rawSettings.calendarDirty === 'boolean'
          ? rawSettings.calendarDirty
          : !lastExport,
        calendarHintDismissed: rawSettings.calendarHintDismissed === true,
        lastCalendarExport: lastExport
      }
    };
  }

  function loadState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultState();
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      console.warn('按时：读取本地数据失败，已使用空白数据。', error);
      return createDefaultState();
    }
  }

  function persistState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      console.warn('按时：写入本地数据失败。', error);
      return false;
    }
  }

  function touchSchedule() {
    state.settings.calendarDirty = true;
    state.settings.calendarHintDismissed = false;
  }

  function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
  }

  function isValidDateString(value) {
    if (typeof value !== 'string' || !value) return false;
    const time = new Date(value);
    return !Number.isNaN(time.getTime());
  }

  /* ---------------------------------------------------------------------
     Dates and schedule calculations
     --------------------------------------------------------------------- */

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function dateKey(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function parseDateKey(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function addDays(date, amount) {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
  }

  function dateAtTime(day, time) {
    const date = new Date(day);
    const [hours, minutes] = time.split(':').map(Number);
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  function formatDateCN(key) {
    const date = parseDateKey(key);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatDateTimeCN(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatClock(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '--:--';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function doseKey(medId, time) {
    return `${medId}::${time}`;
  }

  function getDosesForDate(key) {
    const targetDate = parseDateKey(key);
    const entries = state.intakes[key] || {};
    const doses = [];

    state.meds.forEach((med) => {
      if (!med.active) return;
      if (key < med.startDate) return;
      if (med.endDate && key > med.endDate) return;

      med.times.forEach((time) => {
        const entry = entries[doseKey(med.id, time)];
        const taken = entry && entry.status === 'taken';
        doses.push({
          medId: med.id,
          medName: med.name,
          dose: med.dose,
          note: med.note,
          color: med.color,
          frequency: med.frequency,
          time,
          key: doseKey(med.id, time),
          due: dateAtTime(targetDate, time),
          entry: entry || null,
          status: taken ? 'taken' : 'pending',
          takenAt: taken ? entry.at : null
        });
      });
    });

    return doses.sort((a, b) => {
      const byTime = a.time.localeCompare(b.time);
      return byTime || a.medName.localeCompare(b.medName, 'zh-CN');
    });
  }

  function getOrphanEntriesForDay(key) {
    const entries = state.intakes[key] || {};
    const scheduledKeys = new Set(getDosesForDate(key).map((dose) => dose.key));
    return Object.entries(entries)
      .filter(([entryKey, entry]) => entry && entry.status === 'taken' && !scheduledKeys.has(entryKey))
      .map(([entryKey, entry]) => ({
        key: entryKey,
        time: entry.scheduled || (entryKey.split('::')[1] || ''),
        medName: entry.medName || '已删除的药物',
        dose: entry.dose || '',
        takenAt: entry.at
      }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  function dayStats(key, now = new Date()) {
    const doses = getDosesForDate(key);
    const isToday = key === dateKey(now);
    const dueDoses = isToday ? doses.filter((dose) => dose.due <= now) : doses;
    const takenAll = doses.filter((dose) => dose.status === 'taken').length;
    const takenDue = dueDoses.filter((dose) => dose.status === 'taken').length;
    return {
      key,
      isToday,
      doses,
      total: doses.length,
      dueTotal: dueDoses.length,
      takenAll,
      takenDue,
      complete: doses.length > 0 && takenAll === doses.length,
      dueComplete: dueDoses.length > 0 && takenDue === dueDoses.length
    };
  }

  function upcomingPending(now = new Date()) {
    return getDosesForDate(dateKey(now))
      .filter((dose) => dose.status !== 'taken')
      .sort((a, b) => a.due - b.due);
  }

  function compactElapsed(milliseconds) {
    const minutes = Math.floor(milliseconds / 60000);
    if (minutes < 1) return '到点';
    if (minutes < 60) return `过${minutes}分`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `过${hours}小时`;
    return '超过一天';
  }

  /* ---------------------------------------------------------------------
     DOM references and static events
     --------------------------------------------------------------------- */

  function cacheElements() {
    els = {
      todayKicker: document.getElementById('todayKicker'),
      todayCompleted: document.getElementById('todayCompleted'),
      todayTotal: document.getElementById('todayTotal'),
      nextDoseText: document.getElementById('nextDoseText'),
      progressRing: document.getElementById('progressRing'),
      progressPercent: document.getElementById('progressPercent'),
      todayCount: document.getElementById('todayCount'),
      todayList: document.getElementById('todayList'),
      todayEmpty: document.getElementById('todayEmpty'),
      todayEmptyTitle: document.getElementById('todayEmptyTitle'),
      todayEmptyCopy: document.getElementById('todayEmptyCopy'),
      emptyAddButton: document.getElementById('emptyAddButton'),
      calendarHint: document.getElementById('calendarHint'),
      openCalendarHint: document.getElementById('openCalendarHint'),
      dismissCalendarHint: document.getElementById('dismissCalendarHint'),
      medList: document.getElementById('medList'),
      medsEmpty: document.getElementById('medsEmpty'),
      historyList: document.getElementById('historyList'),
      adherencePercent: document.getElementById('adherencePercent'),
      adherenceSub: document.getElementById('adherenceSub'),
      streakCount: document.getElementById('streakCount'),
      weekBars: document.getElementById('weekBars'),
      views: {
        today: document.getElementById('view-today'),
        meds: document.getElementById('view-meds'),
        history: document.getElementById('view-history')
      },
      tabs: Array.from(document.querySelectorAll('.tab[data-view]')),
      openSettingsButton: document.getElementById('openSettingsButton'),
      footerBackupButton: document.getElementById('footerBackupButton'),
      addMedButton: document.getElementById('addMedButton'),
      emptyAddMedButton: document.getElementById('emptyAddMedButton'),
      openCalendarButton: document.getElementById('openCalendarButton'),

      medDialog: document.getElementById('medDialog'),
      medForm: document.getElementById('medForm'),
      medDialogKicker: document.getElementById('medDialogKicker'),
      medDialogTitle: document.getElementById('medDialogTitle'),
      medId: document.getElementById('medId'),
      medName: document.getElementById('medName'),
      medDose: document.getElementById('medDose'),
      medColorInputs: Array.from(document.querySelectorAll('input[name="medColor"]')),
      medActive: document.getElementById('medActive'),
      medStartDate: document.getElementById('medStartDate'),
      medEndDate: document.getElementById('medEndDate'),
      medNote: document.getElementById('medNote'),
      moreOptions: document.getElementById('moreOptions'),
      frequencyInputs: Array.from(document.querySelectorAll('input[name="frequency"]')),
      timeFields: document.getElementById('timeFields'),
      timeHelp: document.getElementById('timeHelp'),
      addTimeButton: document.getElementById('addTimeButton'),
      medFormError: document.getElementById('medFormError'),
      deleteMedButton: document.getElementById('deleteMedButton'),
      saveMedButton: document.getElementById('saveMedButton'),

      settingsDialog: document.getElementById('settingsDialog'),
      notificationStatus: document.getElementById('notificationStatus'),
      notificationButton: document.getElementById('notificationButton'),
      testNotificationButton: document.getElementById('testNotificationButton'),
      notificationHelp: document.getElementById('notificationHelp'),
      soundToggle: document.getElementById('soundToggle'),
      settingsCalendarButton: document.getElementById('settingsCalendarButton'),
      calendarExportHint: document.getElementById('calendarExportHint'),
      exportBackupButton: document.getElementById('exportBackupButton'),
      importBackupButton: document.getElementById('importBackupButton'),
      clearAllButton: document.getElementById('clearAllButton'),
      settingsError: document.getElementById('settingsError'),

      calendarDialog: document.getElementById('calendarDialog'),
      downloadCalendarButton: document.getElementById('downloadCalendarButton'),
      calendarDialogStatus: document.getElementById('calendarDialogStatus'),
      calendarDelivery: document.getElementById('calendarDelivery'),
      calendarEventCount: document.getElementById('calendarEventCount'),
      calendarShareButton: document.getElementById('calendarShareButton'),
      calendarDownloadLink: document.getElementById('calendarDownloadLink'),
      calendarIosHelp: document.getElementById('calendarIosHelp'),
      calendarAndroidHelp: document.getElementById('calendarAndroidHelp'),

      confirmDialog: document.getElementById('confirmDialog'),
      confirmTitle: document.getElementById('confirmTitle'),
      confirmMessage: document.getElementById('confirmMessage'),
      confirmCancel: document.getElementById('confirmCancel'),
      confirmAccept: document.getElementById('confirmAccept'),

      toast: document.getElementById('toast'),
      toastText: document.getElementById('toastText'),
      toastAction: document.getElementById('toastAction'),
      toastClose: document.getElementById('toastClose'),
      importFile: document.getElementById('importFile')
    };
  }

  function bindEvents() {
    els.openSettingsButton.addEventListener('click', openSettings);
    els.footerBackupButton.addEventListener('click', exportBackup);
    els.addMedButton.addEventListener('click', () => openMedForm());
    els.emptyAddMedButton.addEventListener('click', () => openMedForm());
    els.emptyAddButton.addEventListener('click', handleEmptyAddClick);
    els.openCalendarButton.addEventListener('click', openCalendarDialog);
    els.openCalendarHint.addEventListener('click', openCalendarDialog);
    els.openCalendarButton.title = '系统日历提醒';
    els.dismissCalendarHint.addEventListener('click', dismissCalendarHint);

    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    els.todayList.addEventListener('click', (event) => {
      const button = event.target.closest('.take-button');
      if (!button) return;
      handleDoseButton(button.dataset.medId, button.dataset.time);
    });

    els.medList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-med]');
      if (!button) return;
      openMedForm(button.dataset.editMed);
    });

    els.historyList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-add-med]');
      if (button) openMedForm();
    });

    els.medForm.addEventListener('submit', handleMedSubmit);
    els.medForm.addEventListener('input', () => hideFormError());
    els.deleteMedButton.addEventListener('click', handleDeleteMed);
    els.addTimeButton.addEventListener('click', handleAddTime);
    els.timeFields.addEventListener('click', (event) => {
      const removeButton = event.target.closest('.time-row__remove');
      if (!removeButton) return;
      removeTimeRow(removeButton.closest('.time-row'));
    });
    els.frequencyInputs.forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        const frequency = FREQUENCIES[input.value];
        if (input.value !== 'custom' && frequency && frequency.defaults) {
          renderTimeRows(frequency.defaults);
        }
        hideFormError();
        updateTimeHelp();
      });
    });
    els.medStartDate.addEventListener('change', () => {
      els.medEndDate.min = els.medStartDate.value || '';
      if (els.medEndDate.value && els.medStartDate.value && els.medEndDate.value < els.medStartDate.value) {
        showFormError('结束日期不能早于开始日期。');
      } else {
        hideFormError();
      }
    });

    document.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => {
        const dialog = document.getElementById(button.dataset.closeDialog);
        if (dialog) closeDialog(dialog);
      });
    });

    document.querySelectorAll('dialog.sheet').forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) closeDialog(dialog);
      });
    });

    els.soundToggle.addEventListener('change', () => {
      state.settings.sound = els.soundToggle.checked;
      persistState();
      if (state.settings.sound) {
        unlockAudio();
        playChime();
      }
    });

    els.notificationButton.addEventListener('click', requestNotifications);
    els.testNotificationButton.addEventListener('click', testNotification);
    els.settingsCalendarButton.addEventListener('click', openCalendarDialog);
    els.downloadCalendarButton.addEventListener('click', downloadCalendar);
    els.calendarShareButton.addEventListener('click', shareCalendarFile);
    els.calendarDownloadLink.addEventListener('click', handleCalendarDownload);
    els.calendarDialog.addEventListener('close', resetCalendarDelivery);
    els.exportBackupButton.addEventListener('click', exportBackup);
    els.importBackupButton.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', handleImportFile);
    els.clearAllButton.addEventListener('click', clearAllData);

    els.toastAction.addEventListener('click', () => {
      const handler = els.toastAction._handler;
      hideToast();
      if (typeof handler === 'function') handler();
    });
    els.toastClose.addEventListener('click', hideToast);

    document.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('storage', handleStorageChange);
  }

  /* ---------------------------------------------------------------------
     View and common UI
     --------------------------------------------------------------------- */

  function switchView(viewName) {
    if (!els.views[viewName]) return;
    currentView = viewName;
    Object.entries(els.views).forEach(([name, view]) => {
      view.hidden = name !== viewName;
    });
    els.tabs.forEach((tab) => {
      const active = tab.dataset.view === viewName;
      tab.classList.toggle('is-active', active);
      if (active) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    });
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (viewName === 'history') renderHistory();
    if (viewName === 'meds') renderMedications();
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function showDialog(dialog) {
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    const body = dialog.querySelector('.sheet-body');
    if (body) body.scrollTop = 0;
  }

  function closeDialog(dialog) {
    if (!dialog || !dialog.open) return;
    dialog.close();
  }

  function showToast(message, options = {}) {
    const { actionLabel = '', onAction = null, duration = 4600 } = options;
    window.clearTimeout(toastTimer);
    els.toastText.textContent = message;
    els.toast.hidden = false;

    if (actionLabel && typeof onAction === 'function') {
      els.toastAction.hidden = false;
      els.toastAction.textContent = actionLabel;
      els.toastAction._handler = onAction;
    } else {
      els.toastAction.hidden = true;
      els.toastAction.textContent = '';
      els.toastAction._handler = null;
    }

    toastTimer = window.setTimeout(hideToast, duration);
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    toastTimer = null;
    els.toast.hidden = true;
    els.toastAction._handler = null;
  }

  function confirmAction({ title, message, acceptLabel = '确认', danger = false }) {
    return new Promise((resolve) => {
      els.confirmTitle.textContent = title;
      els.confirmMessage.textContent = message;
      els.confirmAccept.textContent = acceptLabel;
      els.confirmAccept.className = danger ? 'danger-button' : 'primary-button';
      els.confirmDialog.returnValue = '';

      els.confirmDialog.addEventListener('close', () => {
        resolve(els.confirmDialog.returnValue === 'confirm');
      }, { once: true });

      showDialog(els.confirmDialog);
    });
  }

  function setSettingsError(message) {
    if (!message) {
      els.settingsError.textContent = '';
      els.settingsError.hidden = true;
      return;
    }
    els.settingsError.textContent = message;
    els.settingsError.hidden = false;
    els.settingsError.scrollIntoView({ block: 'nearest' });
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    const currentDay = todayKey();
    if (currentDay !== lastDayKey) {
      lastDayKey = currentDay;
      renderAll();
    } else {
      updateHeaderDate();
      updateTodayHero();
      refreshLiveDoseStates();
      updateNotificationUI();
    }
    scanDueReminders();
  }

  function handleStorageChange(event) {
    if (event.key !== STORAGE_KEY) return;
    state = loadState();
    renderAll();
  }

  function tick() {
    const now = new Date();
    const currentDay = dateKey(now);
    if (currentDay !== lastDayKey) {
      lastDayKey = currentDay;
      renderAll();
    } else {
      updateHeaderDate(now);
      updateTodayHero(now);
      refreshLiveDoseStates(now);
    }
    scanDueReminders(now);
  }

  /* ---------------------------------------------------------------------
     Render — today
     --------------------------------------------------------------------- */

  function renderAll() {
    updateHeaderDate();
    renderToday();
    renderMedications();
    renderHistory();
    updateReminderHint();
    updateSettingsMeta();
    updateNotificationUI();
    updateCalendarDialogStatus();
  }

  function updateHeaderDate(now = new Date()) {
    els.todayKicker.textContent = `${now.getMonth() + 1}月${now.getDate()}日 · ${WEEKDAYS[now.getDay()]}`;
  }

  function renderToday() {
    const now = new Date();
    const doses = getDosesForDate(dateKey(now));
    els.todayCount.textContent = `${doses.length} 次`;
    updateTodayHero(now);

    if (!doses.length) {
      els.todayList.hidden = true;
      els.todayList.innerHTML = '';
      els.todayEmpty.hidden = false;
      updateTodayEmpty();
      return;
    }

    els.todayEmpty.hidden = true;
    els.todayList.hidden = false;
    els.todayList.innerHTML = doses.map((dose, index) => doseCardHTML(dose, now, index)).join('');
  }

  function updateTodayEmpty() {
    const hasMeds = state.meds.length > 0;
    const anyActive = state.meds.some((med) => med.active);
    const today = todayKey();
    const hasFuture = state.meds.some((med) => med.active && med.startDate > today);
    const allEnded = state.meds.length > 0 && state.meds.every((med) => med.endDate && med.endDate < today);

    if (!hasMeds) {
      els.todayEmptyTitle.textContent = '今天还没有用药安排';
      els.todayEmptyCopy.textContent = '添加药物、设定每天的服用时间，这里就会自动生成清单。';
      els.emptyAddButton.dataset.mode = 'add';
      setButtonContent(els.emptyAddButton, '添加第一种药', 'i-plus');
      return;
    }

    if (!anyActive) {
      els.todayEmptyTitle.textContent = '目前没有启用的药物';
      els.todayEmptyCopy.textContent = '被暂停的药物不会出现在今天。到「用药」里重新启用，或添加一种新药。';
      els.emptyAddButton.dataset.mode = 'view';
      setButtonContent(els.emptyAddButton, '查看我的药物', 'i-pill');
      return;
    }

    if (allEnded) {
      els.todayEmptyTitle.textContent = '用药计划已经结束';
      els.todayEmptyCopy.textContent = '所有启用的药物都过了结束日期。需要继续服用时，编辑结束日期即可。';
      els.emptyAddButton.dataset.mode = 'view';
      setButtonContent(els.emptyAddButton, '查看我的药物', 'i-pill');
      return;
    }

    if (hasFuture) {
      els.todayEmptyTitle.textContent = '还没有到开始日期';
      els.todayEmptyCopy.textContent = '药物已经添加，到了开始日期就会出现在今天的安排里。';
      els.emptyAddButton.dataset.mode = 'view';
      setButtonContent(els.emptyAddButton, '查看我的药物', 'i-pill');
      return;
    }

    els.todayEmptyTitle.textContent = '今天没有需要服用的药物';
    els.todayEmptyCopy.textContent = '今日没有匹配的提醒时间，可以查看用药计划。';
    els.emptyAddButton.dataset.mode = 'view';
    setButtonContent(els.emptyAddButton, '查看我的药物', 'i-pill');
  }

  function setButtonContent(button, label, iconId) {
    button.innerHTML = `<svg class="icon"><use href="#${iconId}"/></svg>${escapeHTML(label)}`;
  }

  function doseCardHTML(dose, now, index) {
    const isTaken = dose.status === 'taken';
    const elapsed = now.getTime() - dose.due.getTime();
    const isLate = !isTaken && elapsed >= 0;
    const isVeryLate = isLate && elapsed >= ALERT_WINDOW_MS;
    let statusClass = '';
    if (isTaken) statusClass = 'dose-card--taken';
    else if (isVeryLate) statusClass = 'dose-card--overdue';
    else if (isLate) statusClass = 'dose-card--due';

    let stateLabel = '待服';
    if (isTaken) stateLabel = '已记录';
    else if (isLate) stateLabel = compactElapsed(elapsed);

    const recordText = isTaken && dose.takenAt
      ? `<p class="dose-record">${formatClock(dose.takenAt)} 勾选</p>`
      : '';
    const noteText = dose.note
      ? `<p class="dose-note" title="${escapeAttr(dose.note)}">${escapeHTML(dose.note)}</p>`
      : '';
    const color = COLORS.has(dose.color) ? dose.color : 'teal';
    const buttonLabel = isTaken ? '已服' : '打卡';
    const ariaLabel = isTaken
      ? `撤销${dose.medName}${dose.time}的服药记录`
      : `把${dose.medName}${dose.time}的这一次标记为已服`;
    const title = isTaken ? '点击撤销这次记录' : '点击记录这一次服药';
    const safeName = escapeHTML(dose.medName);
    const safeDose = escapeHTML(dose.dose);
    const safeTime = escapeAttr(dose.time);
    const safeMedId = escapeAttr(dose.medId);
    const safeNote = noteText;

    return `
      <article class="dose-card ${statusClass}" data-med-id="${safeMedId}" data-time="${safeTime}" data-status="${isTaken ? 'taken' : 'pending'}" style="animation-delay:${Math.min(index, 6) * 32}ms">
        <div class="dose-time">
          <span>${escapeHTML(dose.time)}</span>
          <span class="dose-state">${stateLabel}</span>
        </div>
        <div class="dose-main">
          <div class="dose-name-row">
            <span class="med-dot med-dot--${color}" aria-hidden="true"></span>
            <h3 class="dose-name" title="${escapeAttr(dose.medName)}">${safeName}</h3>
          </div>
          <p class="dose-amount">${safeDose}</p>
          ${safeNote}
          ${recordText}
        </div>
        <button class="take-button" type="button" data-med-id="${safeMedId}" data-time="${safeTime}" aria-pressed="${isTaken}" aria-label="${escapeAttr(ariaLabel)}" title="${escapeAttr(title)}">
          <svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>
          <span>${buttonLabel}</span>
        </button>
      </article>
    `;
  }

  function updateTodayHero(now = new Date()) {
    const doses = getDosesForDate(dateKey(now));
    const total = doses.length;
    const completed = doses.filter((dose) => dose.status === 'taken').length;
    const pct = total ? Math.round((completed / total) * 100) : 0;

    els.todayCompleted.textContent = String(completed);
    els.todayTotal.textContent = String(total);
    els.progressPercent.textContent = `${pct}%`;
    els.progressRing.style.setProperty('--progress', String(pct));
    els.progressRing.setAttribute('aria-label', `今日服药完成 ${pct}%`);

    const pending = doses.filter((dose) => dose.status !== 'taken');
    const late = pending.filter((dose) => dose.due <= now);
    const future = pending.filter((dose) => dose.due > now).sort((a, b) => a.due - b.due);

    let message = '先添加第一种药，把时间记下来。';
    if (state.meds.length > 0 && total === 0) {
      message = '今天没有需要服用的药物。';
    } else if (total > 0) {
      if (!pending.length) {
        message = '今天的每一次服药，都记好了。';
      } else if (late.length) {
        message = `有 ${late.length} 次到了时间，服完记得勾选。`;
      } else if (future.length) {
        message = `下一次 ${future[0].time} · ${future[0].medName}`;
      }
    }
    els.nextDoseText.textContent = message;

    const overdueForTitle = late.length;
    document.title = overdueForTitle
      ? `(${overdueForTitle}) 该服药了 · 按时`
      : '按时 · 每日服药提醒';
  }

  function refreshLiveDoseStates(now = new Date()) {
    const cards = els.todayList.querySelectorAll('.dose-card[data-status="pending"]');
    cards.forEach((card) => {
      const time = card.dataset.time;
      if (!TIME_PATTERN.test(time)) return;
      const due = dateAtTime(now, time);
      const elapsed = now.getTime() - due.getTime();
      const stateLabel = card.querySelector('.dose-state');
      const isLate = elapsed >= 0;
      card.classList.toggle('dose-card--overdue', elapsed >= ALERT_WINDOW_MS);
      card.classList.toggle('dose-card--due', isLate && elapsed < ALERT_WINDOW_MS);
      if (stateLabel) stateLabel.textContent = isLate ? compactElapsed(elapsed) : '待服';
    });
    updateHeaderDate(now);
  }

  function handleEmptyAddClick() {
    if (els.emptyAddButton.dataset.mode === 'view') {
      switchView('meds');
    } else {
      openMedForm();
    }
  }

  function jumpToDose(medId, time) {
    switchView('today');
    window.requestAnimationFrame(() => {
      const cards = Array.from(els.todayList.querySelectorAll('.dose-card'));
      const card = cards.find((item) => item.dataset.medId === medId && item.dataset.time === time);
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      card.classList.add('is-highlight');
      const button = card.querySelector('.take-button');
      if (button) button.focus({ preventScroll: true });
      window.setTimeout(() => card.classList.remove('is-highlight'), 1700);
    });
  }

  /* ---------------------------------------------------------------------
     Render — medications
     --------------------------------------------------------------------- */

  function renderMedications() {
    const hasMeds = state.meds.length > 0;
    els.medsEmpty.hidden = hasMeds;
    els.medList.hidden = !hasMeds;

    if (!hasMeds) {
      els.medList.innerHTML = '';
      return;
    }

    els.medList.innerHTML = state.meds.map((med, index) => {
      const frequency = FREQUENCIES[med.frequency] || FREQUENCIES.custom;
      const isPaused = !med.active;
      const color = COLORS.has(med.color) ? med.color : 'teal';
      const today = todayKey();
      let rangeText = '';
      if (med.startDate > today) rangeText += ` · ${formatDateCN(med.startDate)}开始`;
      if (med.endDate) rangeText += ` · 至 ${formatDateCN(med.endDate)}`;
      const note = med.note
        ? `<p class="med-card__note">${escapeHTML(med.note)}</p>`
        : '';
      const times = med.times.map((time) => `<span class="med-time-chip">${escapeHTML(time)}</span>`).join('');
      const tag = isPaused
        ? '<span class="med-card__tag med-card__tag--paused">已暂停</span>'
        : `<span class="med-card__tag">${escapeHTML(frequency.short)}</span>`;

      return `
        <article class="med-card ${isPaused ? 'med-card--paused' : ''}" style="animation: cardIn 300ms ease ${Math.min(index, 6) * 35}ms both">
          <div class="med-card__main">
            <div class="med-card__header">
              <span class="med-pill-badge med-pill-badge--${color}" aria-hidden="true">
                <svg class="icon"><use href="#i-pill"/></svg>
              </span>
              <h3 class="med-card__title">${escapeHTML(med.name)}</h3>
              ${tag}
            </div>
            <p class="med-card__dose">每次 ${escapeHTML(med.dose)}</p>
            <p class="med-card__schedule">${escapeHTML(frequency.label)} · ${med.times.length} 个提醒时间${escapeHTML(rangeText)}</p>
            <div class="med-times">${times}</div>
            ${note}
          </div>
          <button class="med-card__edit" type="button" data-edit-med="${escapeAttr(med.id)}" aria-label="编辑 ${escapeAttr(med.name)}" title="编辑">
            <svg class="icon"><use href="#i-chevron"/></svg>
          </button>
        </article>
      `;
    }).join('');
  }

  /* ---------------------------------------------------------------------
     Render — history
     --------------------------------------------------------------------- */

  function renderHistory() {
    const now = new Date();
    const days = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = addDays(now, -offset);
      const key = dateKey(date);
      days.push({ date, ...dayStats(key, now) });
    }

    const totalPlanned = days.reduce((sum, day) => sum + day.total, 0);
    const totalTaken = days.reduce((sum, day) => sum + day.takenAll, 0);
    const rate = totalPlanned ? Math.round((totalTaken / totalPlanned) * 100) : null;

    els.adherencePercent.textContent = rate === null ? '--' : String(rate);
    els.adherenceSub.textContent = totalPlanned
      ? `${totalTaken} / ${totalPlanned} 次已记录${days.some((day) => day.isToday && day.total > 0) ? ' · 含今日计划' : ''}`
      : '还没有可统计的记录';
    els.streakCount.textContent = String(calculateStreak(now));

    els.weekBars.innerHTML = days.map((day) => {
      const hasPlan = day.total > 0;
      let fill = 0;
      if (hasPlan) fill = Math.round((day.takenAll / day.total) * 100);
      const isPartial = fill > 0 && fill < 100;
      const classes = [
        'week-bar',
        hasPlan ? '' : 'week-bar--none',
        isPartial ? 'week-bar--partial' : '',
        day.isToday ? 'is-today' : ''
      ].filter(Boolean).join(' ');
      const dateNumber = day.date.getDate();
      const weekLabel = day.isToday ? '今' : WEEKDAYS_SHORT[day.date.getDay()];
      const aria = hasPlan
        ? `${formatDateCN(day.key)}，完成 ${fill}%`
        : `${formatDateCN(day.key)}，没有用药安排`;
      return `
        <div class="${classes}" title="${escapeAttr(aria)}">
          <div class="week-bar__track" aria-hidden="true">
            <span class="week-bar__fill" style="--fill:${fill}%"></span>
          </div>
          <span class="week-bar__day">${weekLabel}</span>
          <span class="week-bar__date">${dateNumber}</span>
        </div>
      `;
    }).join('');
    els.weekBars.setAttribute('aria-label', `最近七天：${days.map((day) => `${formatDateCN(day.key)}${day.total ? `完成 ${Math.round((day.takenAll / day.total) * 100)}%` : '无用药安排'}`).join('；')}`);

    const hasAnyRecord = state.meds.length > 0 || Object.keys(state.intakes).length > 0;
    if (!hasAnyRecord) {
      els.historyList.innerHTML = `
        <div class="empty-card history-empty">
          <div class="empty-illustration empty-illustration--small" aria-hidden="true">
            <span class="empty-illustration__ring"></span>
            <span class="empty-pill empty-pill--two"><i></i></span>
          </div>
          <h3>还没有服药记录</h3>
          <p>添加第一种药后，每天的勾选都会在这里形成一条清晰的时间线。</p>
          <button class="primary-button" type="button" data-open-add-med>
            <svg class="icon"><use href="#i-plus"/></svg> 添加药物
          </button>
        </div>
      `;
      return;
    }

    els.historyList.innerHTML = [...days].reverse().map((day) => {
      const label = day.isToday ? '今天' : (day.key === dateKey(addDays(now, -1)) ? '昨天' : formatDateCN(day.key));
      const dateText = day.isToday
        ? `${formatDateCN(day.key)} · ${WEEKDAYS[day.date.getDay()]}`
        : WEEKDAYS[day.date.getDay()];
      const summary = historySummary(day);
      const detailRows = historyDetailRows(day);
      return `
        <details class="history-day">
          <summary>
            <div class="history-day__date">
              <strong>${escapeHTML(label)}</strong>
              <span>${escapeHTML(dateText)}</span>
            </div>
            <div class="history-day__right">
              <span class="history-pill ${summary.className}">${escapeHTML(summary.text)}</span>
              <svg class="icon history-chevron" aria-hidden="true"><use href="#i-chevron"/></svg>
            </div>
          </summary>
          <div class="history-detail">
            ${detailRows}
          </div>
        </details>
      `;
    }).join('');
  }

  function historySummary(day) {
    if (!day.total) return { text: '无安排', className: 'history-pill--none' };
    if (day.complete) return { text: '全部完成', className: 'history-pill--full' };
    if (day.isToday) {
      if (!day.dueTotal) return { text: '待开始', className: 'history-pill--none' };
      if (day.takenAll === 0) return { text: '待记录', className: 'history-pill--partial' };
      return { text: `${day.takenAll} / ${day.total} 次`, className: 'history-pill--partial' };
    }
    if (day.takenAll === 0) return { text: '未记录', className: 'history-pill--missed' };
    return { text: `${day.takenAll} / ${day.total} 次`, className: 'history-pill--partial' };
  }

  function historyDetailRows(day) {
    const rows = [];
    day.doses.forEach((dose) => {
      const taken = dose.status === 'taken';
      let status = '未记录';
      let statusClass = 'history-dose__status--missing';
      if (taken) {
        status = `已服 ${formatClock(dose.takenAt)}`;
        statusClass = 'history-dose__status--taken';
      } else if (day.isToday && dose.due > new Date()) {
        status = '待服';
        statusClass = '';
      }
      rows.push(`
        <div class="history-dose">
          <span class="history-dose__time">${escapeHTML(dose.time)}</span>
          <span class="history-dose__name">${escapeHTML(dose.medName)} <small>${escapeHTML(dose.dose)}</small></span>
          <span class="history-dose__status ${statusClass}">${escapeHTML(status)}</span>
        </div>
      `);
    });

    getOrphanEntriesForDay(day.key).forEach((entry) => {
      rows.push(`
        <div class="history-dose">
          <span class="history-dose__time">${escapeHTML(entry.time || '--:--')}</span>
          <span class="history-dose__name">${escapeHTML(entry.medName)} <small>旧计划记录</small></span>
          <span class="history-dose__status history-dose__status--taken">已服 ${formatClock(entry.takenAt)}</span>
        </div>
      `);
    });

    if (!rows.length) {
      return '<p class="history-no-plan">当天没有用药安排。</p>';
    }
    return rows.join('');
  }

  function calculateStreak(now = new Date()) {
    const today = dayStats(todayKey(), now);
    let streak = 0;
    let offset = 1;

    if (today.total > 0 && today.complete) {
      streak = 1;
    }

    for (let index = 0; index < 366; index += 1) {
      const key = dateKey(addDays(now, -(offset + index)));
      const stats = dayStats(key, now);
      if (!stats.total) break;
      if (!stats.complete) break;
      streak += 1;
    }
    return streak;
  }

  /* ---------------------------------------------------------------------
     Reminder hint, settings metadata
     --------------------------------------------------------------------- */

  function updateReminderHint() {
    const hasActive = state.meds.some((med) => med.active);
    const show = hasActive && state.settings.calendarDirty && !state.settings.calendarHintDismissed;
    els.calendarHint.hidden = !show;
  }

  function dismissCalendarHint() {
    state.settings.calendarHintDismissed = true;
    persistState();
    updateReminderHint();
  }

  function updateSettingsMeta() {
    const last = state.settings.lastCalendarExport;
    const hasActive = state.meds.some((med) => med.active);
    if (!last) {
      els.calendarExportHint.textContent = hasActive
        ? '还没有生成日历提醒。'
        : '添加并启用药物后，可以生成系统日历提醒。';
    } else {
      const when = formatDateTimeCN(last);
      els.calendarExportHint.textContent = state.settings.calendarDirty
        ? `上次生成：${when}。药物或时间有更新，建议重新生成。`
        : `上次生成：${when}。如需新的设备提醒，可以再次生成。`;
    }
    els.soundToggle.checked = state.settings.sound;
  }

  function openSettings() {
    setSettingsError('');
    updateSettingsMeta();
    updateNotificationUI();
    showDialog(els.settingsDialog);
  }

  /* ---------------------------------------------------------------------
     Medication form
     --------------------------------------------------------------------- */

  function openMedForm(medId = null) {
    editingMedId = medId || null;
    const med = medId ? state.meds.find((item) => item.id === medId) : null;
    if (medId && !med) return;

    els.medForm.reset();
    hideFormError();
    els.timeFields.innerHTML = '';
    els.deleteMedButton.hidden = !med;
    els.medDialogKicker.textContent = med ? 'EDIT MEDICATION' : 'NEW MEDICATION';
    els.medDialogTitle.textContent = med ? '编辑药物' : '添加药物';
    els.saveMedButton.textContent = med ? '保存修改' : '保存药物';
    els.medId.value = med ? med.id : '';
    els.medName.value = med ? med.name : '';
    els.medDose.value = med ? med.dose : '';
    els.medActive.checked = med ? med.active : true;
    els.medStartDate.value = med ? med.startDate : todayKey();
    els.medEndDate.value = med ? (med.endDate || '') : '';
    els.medEndDate.min = els.medStartDate.value;
    els.medNote.value = med ? med.note : '';
    els.medName.classList.remove('is-invalid');

    const selectedFrequency = med ? med.frequency : 'qd';
    els.frequencyInputs.forEach((input) => {
      input.checked = input.value === selectedFrequency;
    });

    const selectedColor = med && COLORS.has(med.color) ? med.color : 'teal';
    els.medColorInputs.forEach((input) => {
      input.checked = input.value === selectedColor;
    });

    const times = med ? med.times : FREQUENCIES.qd.defaults;
    renderTimeRows(times);

    els.moreOptions.open = Boolean(med && ((med.endDate) || med.note || med.startDate !== todayKey()));
    showDialog(els.medDialog);
    window.setTimeout(() => {
      const body = els.medDialog.querySelector('.sheet-body');
      if (body) body.scrollTop = 0;
    }, 0);
  }

  function renderTimeRows(times) {
    els.timeFields.innerHTML = '';
    const safeTimes = (Array.isArray(times) && times.length ? times : ['08:00'])
      .filter((time) => TIME_PATTERN.test(time))
      .slice(0, MAX_TIMES);
    if (!safeTimes.length) safeTimes.push('08:00');
    safeTimes.forEach((time) => addTimeRow(time));
    updateTimeHelp();
  }

  function addTimeRow(time = '08:00') {
    const row = document.createElement('div');
    row.className = 'time-row';
    row.innerHTML = `
      <svg class="icon time-row__icon" aria-hidden="true"><use href="#i-clock"/></svg>
      <input type="time" step="300" value="${escapeAttr(time)}" aria-label="提醒时间" required>
      <button class="time-row__remove" type="button" aria-label="删除这个提醒时间" title="删除这个时间">
        <svg class="icon"><use href="#i-close"/></svg>
      </button>
    `;
    els.timeFields.appendChild(row);
  }

  function handleAddTime() {
    const count = els.timeFields.querySelectorAll('input[type="time"]').length;
    if (count >= MAX_TIMES) {
      showFormError(`最多设置 ${MAX_TIMES} 个提醒时间。`);
      return;
    }
    const used = new Set(Array.from(els.timeFields.querySelectorAll('input[type="time"]')).map((input) => input.value));
    const suggestions = ['08:00', '12:00', '18:00', '20:00', '22:00', '06:00', '09:00', '14:00', '16:00'];
    const next = suggestions.find((time) => !used.has(time)) || '12:00';
    addTimeRow(next);
    hideFormError();
    syncFrequencyWithTimeCount();
    updateTimeHelp();
    const inputs = els.timeFields.querySelectorAll('input[type="time"]');
    const last = inputs[inputs.length - 1];
    if (last) last.focus({ preventScroll: false });
  }

  function removeTimeRow(row) {
    if (!row) return;
    const count = els.timeFields.querySelectorAll('.time-row').length;
    if (count <= 1) {
      showFormError('至少保留一个提醒时间。');
      return;
    }
    row.remove();
    hideFormError();
    syncFrequencyWithTimeCount();
    updateTimeHelp();
  }

  function syncFrequencyWithTimeCount() {
    const selected = els.frequencyInputs.find((input) => input.checked);
    if (!selected || selected.value === 'custom') return;
    const preset = FREQUENCIES[selected.value];
    const count = els.timeFields.querySelectorAll('input[type="time"]').length;
    if (preset && preset.defaults && preset.defaults.length !== count) {
      const custom = els.frequencyInputs.find((input) => input.value === 'custom');
      if (custom) custom.checked = true;
    }
  }

  function updateTimeHelp() {
    const count = els.timeFields.querySelectorAll('input[type="time"]').length;
    let timezone = '';
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (error) {
      timezone = '';
    }
    els.timeHelp.textContent = `${count} 个每日提醒时间${timezone ? ` · 按 ${timezone} 本地时间` : ''}。`;
  }

  function getFormTimes() {
    return Array.from(els.timeFields.querySelectorAll('input[type="time"]'))
      .map((input) => input.value)
      .filter(Boolean)
      .sort();
  }

  function showFormError(message) {
    els.medFormError.textContent = message;
    els.medFormError.hidden = false;
    els.medFormError.scrollIntoView({ block: 'nearest' });
  }

  function hideFormError() {
    els.medFormError.hidden = true;
    els.medFormError.textContent = '';
  }

  async function handleMedSubmit(event) {
    event.preventDefault();
    hideFormError();

    const name = els.medName.value.trim();
    const dose = els.medDose.value.trim();
    const startDate = els.medStartDate.value;
    const endDate = els.medEndDate.value || null;
    const times = getFormTimes();
    const selectedFrequency = els.frequencyInputs.find((input) => input.checked);
    const selectedColor = els.medColorInputs.find((input) => input.checked);

    if (!name) {
      showFormError('请填写药物名称。');
      els.medName.focus();
      return;
    }
    if (!dose) {
      showFormError('请填写每次用量，例如“1 片”。');
      els.medDose.focus();
      return;
    }
    if (!times.length) {
      showFormError('请至少设置一个提醒时间。');
      return;
    }
    if (times.some((time) => !TIME_PATTERN.test(time))) {
      showFormError('提醒时间格式不正确，请重新选择。');
      return;
    }
    if (new Set(times).size !== times.length) {
      showFormError('提醒时间不能重复。');
      return;
    }
    if (!DATE_PATTERN.test(startDate)) {
      showFormError('请选择有效的开始日期。');
      els.medStartDate.focus();
      return;
    }
    if (endDate && !DATE_PATTERN.test(endDate)) {
      showFormError('结束日期格式不正确。');
      els.medEndDate.focus();
      return;
    }
    if (endDate && endDate < startDate) {
      showFormError('结束日期不能早于开始日期。');
      els.medEndDate.focus();
      return;
    }

    const existing = editingMedId ? state.meds.find((med) => med.id === editingMedId) : null;
    if (!existing && state.meds.length >= MAX_MEDS) {
      showFormError(`最多保存 ${MAX_MEDS} 种药物。`);
      return;
    }
    const timesChanged = !existing || existing.times.slice().sort().join('|') !== times.join('|');

    let frequencyValue = selectedFrequency ? selectedFrequency.value : 'custom';
    if (frequencyValue !== 'custom') {
      const preset = FREQUENCIES[frequencyValue];
      if (preset && preset.defaults && preset.defaults.length !== times.length) {
        frequencyValue = 'custom';
      }
    }

    if (existing && timesChanged) {
      const todayEntries = Object.entries(state.intakes[todayKey()] || {})
        .filter(([key, entry]) => key.startsWith(`${existing.id}::`) && entry.status === 'taken');
      if (todayEntries.length) {
        const previousTimes = todayEntries
          .map(([key, entry]) => entry.scheduled || key.split('::')[1] || '')
          .filter(Boolean)
          .join('、');
        const confirmed = await confirmAction({
          title: '今天已有服药记录',
          message: `今天已经记录过「${existing.name}」（原定 ${previousTimes}）。修改提醒时间后，请重新核对今天的打卡，旧记录会保留在记录页。确认保存吗？`,
          acceptLabel: '仍然保存',
          danger: false
        });
        if (!confirmed) return;
      }
    }

    const nowIso = new Date().toISOString();
    const nextMed = {
      id: existing ? existing.id : makeId(),
      name,
      dose,
      times,
      frequency: frequencyValue,
      startDate,
      endDate,
      note: els.medNote.value.trim(),
      color: selectedColor && COLORS.has(selectedColor.value) ? selectedColor.value : 'teal',
      active: els.medActive.checked,
      createdAt: existing ? existing.createdAt : nowIso
    };

    if (existing) {
      const index = state.meds.findIndex((med) => med.id === existing.id);
      state.meds[index] = nextMed;
    } else {
      state.meds.push(nextMed);
    }

    touchSchedule();
    const saved = persistState();
    if (!saved) {
      showToast('数据暂时无法写入浏览器存储，请检查隐私模式或存储空间。');
    }
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(() => {});
    }

    closeDialog(els.medDialog);
    renderAll();
    showToast(existing ? `已更新「${name}」。` : `已添加「${name}」。`);
  }

  async function handleDeleteMed() {
    const med = state.meds.find((item) => item.id === editingMedId);
    if (!med) return;
    const confirmed = await confirmAction({
      title: '删除这种药？',
      message: `「${med.name}」会从每日安排中移除。已有打卡数据不会被清空，但相关统计会按新的用药方案重新计算。`,
      acceptLabel: '删除',
      danger: true
    });
    if (!confirmed) return;

    state.meds = state.meds.filter((item) => item.id !== med.id);
    touchSchedule();
    persistState();
    closeDialog(els.medDialog);
    renderAll();
    showToast(`已删除「${med.name}」。`);
  }

  /* ---------------------------------------------------------------------
     Dose actions
     --------------------------------------------------------------------- */

  async function handleDoseButton(medId, time) {
    const med = state.meds.find((item) => item.id === medId);
    if (!med) return;
    const day = todayKey();
    const key = doseKey(medId, time);
    const dayEntries = state.intakes[day] || {};
    const entry = dayEntries[key];

    if (entry && entry.status === 'taken') {
      undoDose(day, key, entry, med, time);
      return;
    }

    const otherEntries = Object.entries(dayEntries)
      .filter(([otherKey, otherEntry]) => otherKey !== key && otherKey.startsWith(`${medId}::`) && otherEntry.status === 'taken');

    if (otherEntries.length) {
      const timesText = otherEntries
        .map(([otherKey, otherEntry]) => {
          const scheduled = otherEntry.scheduled || otherKey.split('::')[1] || '';
          return `${formatClock(otherEntry.at)}${scheduled ? `（原定 ${scheduled}）` : ''}`;
        })
        .join('、');
      const confirmed = await confirmAction({
        title: '今天已经记录过',
        message: `今天已记录过「${med.name}」：${timesText}。请确认这一次不是重复服药。`,
        acceptLabel: '确认记录',
        danger: false
      });
      if (!confirmed) return;
    }

    state.intakes[day] = state.intakes[day] || {};
    state.intakes[day][key] = {
      status: 'taken',
      at: new Date().toISOString(),
      medName: med.name,
      dose: med.dose,
      scheduled: time
    };
    persistState();
    renderAll();
    focusDoseButton(medId, time);
    showToast(`已记录：${med.name} · ${time}`, {
      actionLabel: '撤销',
      duration: 7000,
      onAction: () => {
        const currentDay = state.intakes[day];
        if (!currentDay) return;
        delete currentDay[key];
        if (!Object.keys(currentDay).length) delete state.intakes[day];
        persistState();
        renderAll();
        showToast('已撤销这次记录。');
      }
    });
  }

  function undoDose(day, key, entry, med, time) {
    const backup = { ...entry };
    delete state.intakes[day][key];
    if (!Object.keys(state.intakes[day]).length) delete state.intakes[day];
    persistState();
    renderAll();
    focusDoseButton(med.id, time);
    showToast(`已撤销：${med.name} · ${time}`, {
      actionLabel: '恢复',
      duration: 7000,
      onAction: () => {
        state.intakes[day] = state.intakes[day] || {};
        state.intakes[day][key] = backup;
        persistState();
        renderAll();
        showToast('记录已恢复。');
      }
    });
  }

  function focusDoseButton(medId, time) {
    window.requestAnimationFrame(() => {
      const buttons = Array.from(els.todayList.querySelectorAll('.take-button'));
      const button = buttons.find((item) => item.dataset.medId === medId && item.dataset.time === time);
      if (button) button.focus({ preventScroll: true });
    });
  }

  /* ---------------------------------------------------------------------
     Notifications and sound
     --------------------------------------------------------------------- */

  function getNotificationSupport() {
    const secure = window.isSecureContext;
    const isiOS = /iP(hone|ad|od)/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;

    if (!('Notification' in window) || !secure) {
      if (isiOS && !standalone) {
        return {
          available: false,
          permission: 'unsupported',
          label: '需加到主屏',
          statusClass: 'is-warn',
          buttonLabel: '需加到主屏',
          buttonDisabled: true,
          testDisabled: true,
          help: 'iPhone 上网页通知要求先从 Safari 添加到主屏幕并打开。也可以直接使用系统日历提醒。'
        };
      }
      return {
        available: false,
        permission: 'unsupported',
        label: '不支持',
        statusClass: 'is-warn',
        buttonLabel: '无法开启',
        buttonDisabled: true,
        testDisabled: true,
        help: '当前浏览器环境不支持网页通知。系统日历提醒仍然可用，推荐使用它。'
      };
    }

    if (isiOS && !standalone) {
      return {
        available: false,
        permission: 'unsupported',
        label: '需加到主屏',
        statusClass: 'is-warn',
        buttonLabel: '需加到主屏',
        buttonDisabled: true,
        testDisabled: true,
        help: '在 iPhone 上，请先用 Safari 的“分享 → 添加到主屏幕”安装，再从主屏幕打开并开启通知。'
      };
    }

    if (Notification.permission === 'granted') {
      return {
        available: true,
        permission: 'granted',
        label: '已开启',
        statusClass: 'is-ok',
        buttonLabel: '已开启',
        buttonDisabled: true,
        testDisabled: false,
        help: '通知权限已开启。网页关闭后仍可能无法触发，锁屏提醒请配合系统日历使用。'
      };
    }

    if (Notification.permission === 'denied') {
      return {
        available: true,
        permission: 'denied',
        label: '已阻止',
        statusClass: 'is-error',
        buttonLabel: '已阻止',
        buttonDisabled: true,
        testDisabled: true,
        help: '浏览器已阻止通知。请在地址栏的网站设置中重新允许通知，或继续使用系统日历提醒。'
      };
    }

    return {
      available: true,
      permission: 'default',
      label: '未开启',
      statusClass: 'is-warn',
      buttonLabel: '开启通知',
      buttonDisabled: false,
      testDisabled: false,
      help: '开启后，页面运行时可以收到浏览器通知。网页完全关闭时仍可能不响，建议同时导入系统日历。'
    };
  }

  function updateNotificationUI() {
    if (!els.notificationStatus) return;
    const support = getNotificationSupport();
    els.notificationStatus.textContent = support.label;
    els.notificationStatus.className = `status-pill ${support.statusClass}`;
    els.notificationButton.textContent = support.buttonLabel;
    els.notificationButton.disabled = support.buttonDisabled;
    els.testNotificationButton.disabled = support.testDisabled;
    els.notificationHelp.textContent = support.help;
  }

  async function requestNotifications() {
    if (notificationRequestInFlight) return;
    const support = getNotificationSupport();
    if (!support.available || support.permission !== 'default') return;

    notificationRequestInFlight = true;
    try {
      const permission = await Notification.requestPermission();
      updateNotificationUI();
      if (permission === 'granted') {
        els.notificationHelp.textContent = '通知已开启。网页通知需要页面在运行；锁屏提醒请配合系统日历。';
      } else if (permission === 'denied') {
        els.notificationHelp.textContent = '通知被阻止。请到浏览器网站设置中恢复，或使用系统日历提醒。';
      }
    } catch (error) {
      console.warn('按时：请求通知权限失败。', error);
      els.notificationHelp.textContent = '无法请求通知权限，请检查浏览器设置。';
    } finally {
      notificationRequestInFlight = false;
    }
  }

  async function testNotification() {
    unlockAudio();
    playChime();
    const support = getNotificationSupport();
    if (!support.available) return;

    if (Notification.permission === 'default') {
      await requestNotifications();
    }
    if (Notification.permission !== 'granted') {
      els.notificationStatus.textContent = '未发送';
      els.notificationStatus.className = 'status-pill is-warn';
      return;
    }

    const sent = await pushSystemNotification(
      '测试提醒 · 按时',
      '如果你看到这条通知，说明浏览器通知可以使用。服完药后，记得回到「按时」勾选。',
      { tag: 'ontime-test', forceSound: true }
    );
    els.notificationStatus.textContent = sent ? '测试已发送' : '发送失败';
    els.notificationStatus.className = `status-pill ${sent ? 'is-ok' : 'is-error'}`;
    if (!sent) {
      els.notificationHelp.textContent = '通知权限已开启，但发送失败。请刷新页面或改用系统日历提醒。';
    }
  }

  async function pushSystemNotification(title, body, options = {}) {
    if (!('Notification' in window) || !window.isSecureContext) return false;
    if (Notification.permission !== 'granted') return false;

    const visible = document.visibilityState === 'visible';
    const silent = !state.settings.sound || (visible && !options.forceSound);
    const notificationOptions = {
      body,
      icon: APP_ICON,
      badge: APP_ICON,
      tag: options.tag || 'ontime-reminder',
      renotify: true,
      requireInteraction: true,
      silent,
      lang: 'zh-CN',
      data: { url: window.location.href.split('#')[0] }
    };

    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.showNotification(title, notificationOptions);
          return true;
        }
      }
      const notification = new Notification(title, notificationOptions);
      notification.onclick = () => window.focus();
      return true;
    } catch (error) {
      console.warn('按时：发送系统通知失败。', error);
      return false;
    }
  }

  function scanDueReminders(now = new Date()) {
    const key = dateKey(now);
    const doses = getDosesForDate(key);
    if (!doses.length) return;

    const alerted = loadAlerted(key);
    const dueDoses = doses.filter((dose) => {
      if (dose.status === 'taken' || alerted.has(dose.key)) return false;
      const elapsed = now.getTime() - dose.due.getTime();
      return elapsed >= 0 && elapsed <= ALERT_WINDOW_MS;
    });

    if (!dueDoses.length) return;
    dueDoses.forEach((dose) => alerted.add(dose.key));
    saveAlerted(key, alerted);

    const title = dueDoses.length === 1
      ? '该服药了 · 按时'
      : `该服药了 · ${dueDoses.length} 次`;
    const body = dueDoses.length === 1
      ? `${dueDoses[0].time} ${dueDoses[0].medName}（${dueDoses[0].dose}）。服完后打开「按时」勾选。`
      : `${dueDoses.map((dose) => `${dose.time} ${dose.medName}`).join('、')}。服完后打开「按时」勾选。`;

    pushSystemNotification(title, body, { tag: `ontime-due-${key}` });

    if (document.visibilityState === 'visible') {
      playChime();
      const first = dueDoses[0];
      const names = dueDoses.length === 1
        ? `${first.time} ${first.medName}`
        : `${dueDoses.length} 次服药`;
      showToast(`该服药了：${names}。服完记得勾选。`, {
        actionLabel: '去打卡',
        duration: 12000,
        onAction: () => jumpToDose(first.medId, first.time)
      });
    }
  }

  function loadAlerted(key) {
    try {
      const raw = window.localStorage.getItem(ALERTS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (parsed && parsed.date === key && Array.isArray(parsed.keys)) {
        return new Set(parsed.keys);
      }
    } catch (error) {
      // A broken alert cache should never stop the app.
    }
    return new Set();
  }

  function saveAlerted(key, alerted) {
    try {
      window.localStorage.setItem(ALERTS_KEY, JSON.stringify({ date: key, keys: [...alerted] }));
    } catch (error) {
      // Ignore storage quota errors for ephemeral notification bookkeeping.
    }
  }

  function unlockAudio() {
    if (audioContext) {
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      audioContext = new AudioContextClass();
    } catch (error) {
      audioContext = null;
    }
  }

  function playChime() {
    if (!state.settings.sound) return;
    if (!audioContext) unlockAudio();
    if (!audioContext) return;
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    if (audioContext.state !== 'running') return;

    const start = audioContext.currentTime + 0.03;
    const notes = [
      { frequency: 659.25, offset: 0 },
      { frequency: 880, offset: 0.18 }
    ];
    notes.forEach(({ frequency, offset }) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start + offset);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.065, start + offset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.62);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.65);
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const register = () => {
      navigator.serviceWorker.register('./sw.js').catch((error) => {
        console.warn('按时：离线缓存注册失败。', error);
      });
    };
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }

  /* ---------------------------------------------------------------------
     Calendar export
     --------------------------------------------------------------------- */

  function openCalendarDialog() {
    if (!state.meds.some((med) => med.active)) {
      switchView('meds');
      showToast('先添加并启用一种药物，再生成日历提醒。');
      return;
    }
    resetCalendarDelivery();
    configureCalendarPlatformHelp();
    updateCalendarDialogStatus();
    showDialog(els.calendarDialog);
  }

  function updateCalendarDialogStatus(message = '', status = '') {
    if (!els.calendarDialogStatus) return;
    if (message) {
      els.calendarDialogStatus.textContent = message;
      els.calendarDialogStatus.className = `calendar-status${status ? ` ${status}` : ''}`;
      return;
    }
    const last = state.settings.lastCalendarExport;
    if (!last) {
      els.calendarDialogStatus.textContent = '还没有生成日历文件。';
      els.calendarDialogStatus.className = 'calendar-status';
      return;
    }
    const when = formatDateTimeCN(last);
    els.calendarDialogStatus.textContent = state.settings.calendarDirty
      ? `上次生成：${when}。药物或时间有更新，建议重新生成。`
      : `上次生成：${when}。`;
    els.calendarDialogStatus.className = 'calendar-status';
  }

  function buildCalendar() {
    const now = new Date();
    const today = dateKey(now);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时间';
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//OnTime//Medication Reminder//ZH-CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:按时 · 服药提醒',
      'X-WR-CALDESC:由按时生成。系统日历负责提醒，按时负责勾选记录。',
      `X-WR-TIMEZONE:${timezone}`
    ];
    let eventCount = 0;

    state.meds.forEach((med) => {
      if (!med.active) return;
      if (med.endDate && med.endDate < today) return;

      med.times.forEach((time) => {
        if (med.endDate === today) {
          const thisOccurrence = dateAtTime(parseDateKey(today), time);
          if (thisOccurrence < now) return;
        }

        const startKey = med.startDate > today ? med.startDate : today;
        if (med.endDate && startKey > med.endDate) return;

        const startDate = dateAtTime(parseDateKey(startKey), time);
        const endDate = new Date(startDate.getTime() + 5 * 60 * 1000);
        const uidBase = med.id.replace(/[^A-Za-z0-9-]/g, '') || 'med';
        const uid = `${uidBase}-${time.replace(':', '')}@ontime.local`;
        const summary = `服药提醒｜${med.name}`;
        const description = [
          `用量：${med.dose}`,
          med.note ? `备注：${med.note}` : '',
          '服完后请打开「按时」勾选记录。'
        ].filter(Boolean).join('\n');
        const alarmDescription = `该服药了：${med.name}（${med.dose}）`;

        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${uid}`);
        lines.push(`DTSTAMP:${icsUtcStamp(now)}`);
        lines.push(`DTSTART:${icsLocalStamp(startDate)}`);
        lines.push(`DTEND:${icsLocalStamp(endDate)}`);
        lines.push(med.endDate
          ? `RRULE:FREQ=DAILY;UNTIL=${med.endDate.replace(/-/g, '')}T235959`
          : 'RRULE:FREQ=DAILY');
        lines.push(`SUMMARY:${escapeIcs(summary)}`);
        lines.push(`DESCRIPTION:${escapeIcs(description)}`);
        lines.push('STATUS:CONFIRMED');
        lines.push('TRANSP:TRANSPARENT');
        lines.push('SEQUENCE:0');
        lines.push('BEGIN:VALARM');
        lines.push('ACTION:DISPLAY');
        lines.push(`DESCRIPTION:${escapeIcs(alarmDescription)}`);
        lines.push('TRIGGER:-PT0M');
        lines.push('END:VALARM');
        lines.push('END:VEVENT');
        eventCount += 1;
      });
    });

    lines.push('END:VCALENDAR');
    const content = lines.map(foldIcsLine).join('\r\n') + '\r\n';
    return { content, eventCount };
  }

  function icsLocalStamp(date) {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
  }

  function icsUtcStamp(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function escapeIcs(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,');
  }

  function foldIcsLine(line) {
    const encoder = new TextEncoder();
    if (encoder.encode(line).length <= 75) return line;
    let result = '';
    let current = '';
    let currentBytes = 0;
    let limit = 75;
    for (const character of line) {
      const size = encoder.encode(character).length;
      if (currentBytes + size > limit) {
        result += current + '\r\n ';
        current = '';
        currentBytes = 0;
        limit = 74;
      }
      current += character;
      currentBytes += size;
    }
    return result + current;
  }

  function configureCalendarPlatformHelp() {
    if (!els.calendarIosHelp || !els.calendarAndroidHelp) return;
    const ua = navigator.userAgent || '';
    const isiOS = /iPhone|iPad|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    els.calendarIosHelp.hidden = isAndroid && !isiOS;
    els.calendarAndroidHelp.hidden = isiOS && !isAndroid;
  }

  function setCalendarGenerateButtonLabel(label) {
    els.downloadCalendarButton.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-calendar"/></svg>${escapeHTML(label)}`;
  }

  function resetCalendarDelivery() {
    if (pendingCalendar && pendingCalendar.url) {
      URL.revokeObjectURL(pendingCalendar.url);
    }
    pendingCalendar = null;
    if (!els.calendarDelivery) return;
    els.calendarDelivery.hidden = true;
    els.calendarShareButton.hidden = true;
    els.calendarShareButton.disabled = false;
    els.calendarDownloadLink.removeAttribute('href');
    els.calendarDownloadLink.removeAttribute('download');
    els.calendarDownloadLink.removeAttribute('type');
    els.calendarDownloadLink.classList.remove('is-primary');
    els.calendarEventCount.textContent = '0';
    setCalendarGenerateButtonLabel('生成 .ics 日历文件');
  }

  function downloadCalendar() {
    resetCalendarDelivery();
    try {
      const { content, eventCount } = buildCalendar();
      if (!eventCount) {
        updateCalendarDialogStatus('当前没有可导出的服药时间。请检查药物是否已启用，以及结束日期是否已过。', 'is-error');
        return;
      }

      // ASCII filename and the bare text/calendar MIME type are deliberately
      // conservative: Chinese filenames or "text/calendar;charset=..." can make
      // some iOS/Android calendar handlers refuse to associate the .ics file.
      const filename = `ontime-medication-${todayKey()}.ics`;
      const blob = new Blob([content], { type: 'text/calendar' });
      const url = URL.createObjectURL(blob);
      let file = null;
      try {
        file = new File([content], filename, { type: 'text/calendar' });
      } catch (error) {
        file = null;
      }

      pendingCalendar = { content, file, url, filename, eventCount };
      els.calendarDownloadLink.href = url;
      els.calendarDownloadLink.download = filename;
      els.calendarDownloadLink.type = 'text/calendar';
      els.calendarEventCount.textContent = String(eventCount);
      const shareAvailable = typeof navigator.share === 'function';
      els.calendarShareButton.hidden = !shareAvailable;
      els.calendarDownloadLink.classList.toggle('is-primary', !shareAvailable);
      els.calendarDelivery.hidden = false;
      setCalendarGenerateButtonLabel('重新生成日历文件');
      updateCalendarDialogStatus(`已生成 ${eventCount} 条每日日程。请选择分享或下载，然后导入手机日历。`, 'is-ok');

      window.setTimeout(() => {
        els.calendarDelivery.scrollIntoView({
          block: 'nearest',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
        });
      }, 100);
    } catch (error) {
      console.warn('按时：生成日历时出错。', error);
      updateCalendarDialogStatus('生成失败，请重试。如果问题持续，可以导出备份后换一个浏览器。', 'is-error');
    }
  }

  function handleCalendarDownload() {
    if (!pendingCalendar) return;
    markCalendarExported();
    updateCalendarDialogStatus(
      '已开始下载。请按下面的步骤，在文件管理器或「文件」App 中打开 .ics，再导入日历。',
      'is-ok'
    );
  }

  async function shareCalendarFile() {
    const pending = pendingCalendar;
    if (!pending) {
      updateCalendarDialogStatus('请先生成日历文件。', 'is-error');
      return;
    }
    if (!pending.file || typeof navigator.share !== 'function') {
      updateCalendarDialogStatus('当前浏览器不支持文件分享，请使用下面的「下载 .ics 文件」。', 'is-error');
      return;
    }

    els.calendarShareButton.disabled = true;
    try {
      // Do not gate this behind navigator.canShare(): Safari on iOS is known to
      // report false for valid files even though the native share sheet works.
      await navigator.share({
        files: [pending.file],
        title: '按时 · 服药提醒'
      });
      markCalendarExported();
      updateCalendarDialogStatus(
        '已打开系统分享面板。若其中没有「日历」，请选择「存储到文件」，再从「文件」App 中打开 .ics。',
        'is-ok'
      );
    } catch (error) {
      if (error && error.name === 'AbortError') {
        updateCalendarDialogStatus('已取消分享。你仍可以使用下面的「下载 .ics 文件」。');
      } else {
        console.warn('按时：系统文件分享失败。', error);
        updateCalendarDialogStatus(
          '系统分享没有接受这个文件，请使用下面的「下载 .ics 文件」，再从文件管理器导入日历。',
          'is-error'
        );
      }
    } finally {
      els.calendarShareButton.disabled = false;
    }
  }

  function markCalendarExported() {
    state.settings.lastCalendarExport = new Date().toISOString();
    state.settings.calendarDirty = false;
    state.settings.calendarHintDismissed = true;
    persistState();
    updateReminderHint();
    updateSettingsMeta();
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---------------------------------------------------------------------
     Backup and restore
     --------------------------------------------------------------------- */

  function exportBackup() {
    try {
      const payload = {
        app: 'ontime',
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        data: state
      };
      const content = JSON.stringify(payload, null, 2);
      downloadBlob(content, `按时-备份-${todayKey()}.json`, 'application/json;charset=utf-8');
      showToast('备份已开始下载。');
    } catch (error) {
      console.warn('按时：导出备份失败。', error);
      if (els.settingsDialog.open) setSettingsError('导出失败，请重试。');
      else showToast('导出失败，请重试。');
    }
  }

  async function handleImportFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;

    setSettingsError('');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('备份文件过大。');
      const text = await file.text();
      const parsed = JSON.parse(text);
      const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      const normalized = normalizeState(data, { strict: true });
      normalized.settings.calendarDirty = true;
      normalized.settings.calendarHintDismissed = false;

      const entryCount = Object.values(normalized.intakes)
        .reduce((sum, day) => sum + Object.keys(day).length, 0);
      const confirmed = await confirmAction({
        title: '导入这份备份？',
        message: `将用 ${normalized.meds.length} 种药物、${entryCount} 条打卡记录覆盖这台设备上的当前数据。此操作无法撤销。`,
        acceptLabel: '导入',
        danger: false
      });
      if (!confirmed) return;

      state = normalized;
      const saved = persistState();
      closeDialog(els.settingsDialog);
      renderAll();
      showToast(saved ? '备份已导入。' : '备份已载入，但写入本地存储失败，请勿刷新页面。', { duration: 6500 });
    } catch (error) {
      console.warn('按时：导入备份失败。', error);
      setSettingsError(`导入失败：${error.message || '文件格式不正确。'}`);
    }
  }

  async function clearAllData() {
    const confirmed = await confirmAction({
      title: '清空所有数据？',
      message: '药物、打卡记录和设置都会从这台设备删除。此操作无法撤销，建议先导出备份。',
      acceptLabel: '全部清空',
      danger: true
    });
    if (!confirmed) return;

    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(ALERTS_KEY);
    } catch (error) {
      console.warn('按时：清空本地数据失败。', error);
    }
    state = createDefaultState();
    closeDialog(els.settingsDialog);
    renderAll();
    showToast('数据已清空。');
  }

  /* ---------------------------------------------------------------------
     Utilities
     --------------------------------------------------------------------- */

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => {
      switch (character) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return character;
      }
    });
  }

  function escapeAttr(value) {
    return escapeHTML(value).replace(/`/g, '&#96;');
  }
})();
