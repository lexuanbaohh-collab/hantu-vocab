(() => {
  "use strict";

  const words = (Array.isArray(window.VOCABULARY) ? window.VOCABULARY : []).filter(
    (word) => word?.hanzi && word?.pinyin && word?.meaning
  );
  const config = window.SUPABASE_CONFIG || {};
  const hasSupabaseConfig =
    /^https:\/\/.+\.supabase\.co$/.test(String(config.url || "")) &&
    Boolean(config.publishableKey) &&
    Boolean(window.supabase?.createClient);
  const supabaseClient = hasSupabaseConfig
    ? window.supabase.createClient(config.url, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;

  const state = {
    mode: "flashcard",
    queue: "today",
    activeIndices: [],
    position: 0,
    flipped: false,
    answered: false,
    correct: 0,
    progress: new Map(),
    session: null,
    authMode: "login",
    syncing: false,
    toastTimer: null
  };

  const elements = {
    studyArea: document.querySelector("#studyArea"),
    progressLabel: document.querySelector("#progressLabel"),
    progressBar: document.querySelector("#progressBar"),
    scoreLabel: document.querySelector("#scoreLabel"),
    wordCount: document.querySelector("#wordCount"),
    previousButton: document.querySelector("#previousButton"),
    nextButton: document.querySelector("#nextButton"),
    shuffleButton: document.querySelector("#shuffleButton"),
    sessionStatus: document.querySelector("#sessionStatus"),
    studiedStat: document.querySelector("#studiedStat"),
    masteredStat: document.querySelector("#masteredStat"),
    reviewStat: document.querySelector("#reviewStat"),
    accuracyStat: document.querySelector("#accuracyStat"),
    queueSummary: document.querySelector("#queueSummary"),
    accountButton: document.querySelector("#accountButton"),
    accountButtonText: document.querySelector("#accountButtonText"),
    syncPill: document.querySelector("#syncPill"),
    accountDialog: document.querySelector("#accountDialog"),
    closeAccountButton: document.querySelector("#closeAccountButton"),
    signedOutView: document.querySelector("#signedOutView"),
    signedInView: document.querySelector("#signedInView"),
    accountEmail: document.querySelector("#accountEmail"),
    accountSyncStatus: document.querySelector("#accountSyncStatus"),
    authForm: document.querySelector("#authForm"),
    emailInput: document.querySelector("#emailInput"),
    passwordInput: document.querySelector("#passwordInput"),
    authSubmitButton: document.querySelector("#authSubmitButton"),
    authMessage: document.querySelector("#authMessage"),
    logoutButton: document.querySelector("#logoutButton"),
    resetProgressButton: document.querySelector("#resetProgressButton"),
    resetGuestProgressButton: document.querySelector("#resetGuestProgressButton"),
    toast: document.querySelector("#toast")
  };

  const modeTabs = [...document.querySelectorAll(".mode-tab")];
  const queueTabs = [...document.querySelectorAll(".queue-tab")];
  const authTabs = [...document.querySelectorAll(".auth-tab")];
  const validWordKeys = new Set(words.map(wordKey));

  function wordKey(word) {
    return word.key || `${word.hanzi}::${word.pinyin}`;
  }

  function storageKey(userId = state.session?.user?.id) {
    return `hantu-progress-v2:${userId || "guest"}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function shuffle(items) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
    }
    return copy;
  }

  function currentWord() {
    const sourceIndex = state.activeIndices[state.position];
    return Number.isInteger(sourceIndex) ? words[sourceIndex] : null;
  }

  function sanitizeProgress(value) {
    if (!value || typeof value !== "object") return null;
    return {
      status: value.status === "mastered" ? "mastered" : "learning",
      attempts: Math.max(0, Number(value.attempts) || 0),
      correctCount: Math.max(0, Number(value.correctCount ?? value.correct_count) || 0),
      wrongCount: Math.max(0, Number(value.wrongCount ?? value.wrong_count) || 0),
      streak: Math.max(0, Number(value.streak) || 0),
      lastResult: value.lastResult ?? value.last_result ?? null,
      lastReviewedAt: value.lastReviewedAt ?? value.last_reviewed_at ?? null,
      nextReviewAt: value.nextReviewAt ?? value.next_review_at ?? null,
      updatedAt: value.updatedAt ?? value.updated_at ?? new Date(0).toISOString()
    };
  }

  function readLocalProgress(userId) {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey(userId)) || "{}");
      return new Map(
        Object.entries(raw)
          .filter(([key]) => validWordKeys.has(key))
          .map(([key, value]) => [key, sanitizeProgress(value)])
          .filter(([, value]) => Boolean(value))
      );
    } catch (_) {
      return new Map();
    }
  }

  function saveLocalProgress() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(Object.fromEntries(state.progress)));
    } catch (_) {
      showToast("Trình duyệt không thể lưu tiến độ trên thiết bị này.");
    }
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = setTimeout(() => {
      elements.toast.hidden = true;
    }, 3200);
  }

  function setSyncState(kind, label) {
    elements.syncPill.className = `sync-pill is-${kind}`;
    elements.syncPill.textContent = label;
  }

  function dueNow(progress) {
    if (!progress?.nextReviewAt) return false;
    return new Date(progress.nextReviewAt).getTime() <= Date.now();
  }

  function buildQueue(queue) {
    const allIndices = words.map((_, index) => index);
    if (queue === "all") return allIndices;
    if (queue === "wrong") {
      return allIndices.filter((index) => state.progress.get(wordKey(words[index]))?.lastResult === "wrong");
    }
    if (queue === "mastered") {
      return allIndices.filter((index) => state.progress.get(wordKey(words[index]))?.status === "mastered");
    }

    const due = allIndices.filter((index) => {
      const progress = state.progress.get(wordKey(words[index]));
      return progress && (progress.lastResult === "wrong" || dueNow(progress));
    });
    const fresh = allIndices
      .filter((index) => !state.progress.has(wordKey(words[index])))
      .slice(0, Math.max(0, 20 - due.length));
    return [...new Set([...due, ...fresh])];
  }

  function queueLabel() {
    const total = state.activeIndices.length;
    if (state.queue === "wrong") return total ? `${total} từ cần làm lại` : "Không còn từ sai";
    if (state.queue === "mastered") return total ? `${total} từ đã nhớ` : "Chưa có từ nào đạt mức đã nhớ";
    if (state.queue === "all") return `${total} từ trong toàn bộ danh sách`;
    return total ? `${total} từ đến lượt học hôm nay` : "Đã hoàn thành lượt ôn hôm nay";
  }

  function applyQueue(queue, { keepPosition = false } = {}) {
    if (!["today", "wrong", "all", "mastered"].includes(queue)) return false;
    state.queue = queue;
    state.activeIndices = buildQueue(queue);
    if (!keepPosition || state.position >= state.activeIndices.length) state.position = 0;
    state.flipped = false;
    state.answered = false;
    state.correct = 0;
    queueTabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.queue === queue));
    render();
    return true;
  }

  function updateStats() {
    let studied = 0;
    let mastered = 0;
    let review = 0;
    let correct = 0;
    let attempts = 0;

    words.forEach((word) => {
      const progress = state.progress.get(wordKey(word));
      if (!progress) return;
      studied += 1;
      if (progress.status === "mastered") mastered += 1;
      if (progress.lastResult === "wrong" || dueNow(progress)) review += 1;
      correct += progress.correctCount;
      attempts += progress.attempts;
    });

    elements.studiedStat.textContent = String(studied);
    elements.masteredStat.textContent = String(mastered);
    elements.reviewStat.textContent = String(review);
    elements.accuracyStat.textContent = attempts ? `${Math.round((correct / attempts) * 100)}%` : "—";
  }

  function updateProgressBar() {
    const total = state.activeIndices.length;
    elements.progressLabel.textContent = total ? `Từ ${state.position + 1} / ${total}` : "Không có từ";
    elements.progressBar.style.width = total ? `${((state.position + 1) / total) * 100}%` : "0%";
    const mastered = [...state.progress.values()].filter((item) => item.status === "mastered").length;
    elements.scoreLabel.textContent = state.mode === "flashcard" ? `Đã nhớ ${mastered}` : `Đúng ${state.correct}`;
    elements.wordCount.textContent = String(total);
    elements.queueSummary.textContent = queueLabel();
  }

  function setMode(mode) {
    if (!["flashcard", "quiz", "write"].includes(mode)) return false;
    state.mode = mode;
    state.flipped = false;
    state.answered = false;
    state.correct = 0;
    modeTabs.forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    render();
    return true;
  }

  function formatReviewHint(word) {
    const progress = state.progress.get(wordKey(word));
    if (!progress) return "Từ mới";
    if (progress.status === "mastered") return "Đã nhớ · ôn định kỳ";
    if (progress.lastResult === "wrong") return "Đang chờ làm lại";
    return `Chuỗi đúng ${progress.streak}/3`;
  }

  function renderEmpty() {
    const title = state.queue === "wrong" ? "Bạn đã xử lý hết từ sai" : "Nhóm này chưa có từ";
    const help = state.queue === "wrong"
      ? "Khi trả lời sai, từ sẽ tự xuất hiện lại ở đây."
      : "Chọn “Hôm nay” hoặc “Tất cả” để tiếp tục học.";
    elements.studyArea.innerHTML = `
      <div class="empty-state">
        <span aria-hidden="true">✓</span>
        <p class="write-prompt">${title}</p>
        <p class="write-help">${help}</p>
      </div>
    `;
    elements.previousButton.disabled = true;
    elements.nextButton.disabled = true;
  }

  function renderFlashcard() {
    const word = currentWord();
    const example = word.example
      ? `<div class="example"><strong>${escapeHtml(word.example)}</strong><span class="example-pinyin">${escapeHtml(word.examplePinyin)}</span><span class="example-meaning">${escapeHtml(word.exampleMeaning)}</span></div>`
      : "";
    const front = `
      <div>
        <p class="hint">Chạm để xem nghĩa</p>
        <p class="hanzi">${escapeHtml(word.hanzi)}</p>
        <p class="pinyin">${escapeHtml(word.pinyin)}</p>
      </div>`;
    const back = `
      <div>
        <p class="hint">${escapeHtml(formatReviewHint(word))}</p>
        <p class="meaning">${escapeHtml(word.meaning)}</p>
        ${example}
      </div>`;

    elements.studyArea.innerHTML = `
      <div>
        <button class="flashcard" id="flashcard" type="button" aria-label="Lật thẻ từ vựng">${state.flipped ? back : front}</button>
        <div class="review-actions">
          <button class="review-button again" id="againButton" type="button">↻ Cần ôn lại</button>
          <button class="review-button known" id="knownButton" type="button">✓ Đã nhớ</button>
        </div>
      </div>`;

    document.querySelector("#flashcard").addEventListener("click", () => {
      state.flipped = !state.flipped;
      renderFlashcard();
    });
    document.querySelector("#againButton").addEventListener("click", () => {
      recordResult(word, false);
      goNext();
    });
    document.querySelector("#knownButton").addEventListener("click", () => {
      recordResult(word, true);
      goNext();
    });
  }

  function makeQuiz() {
    const word = currentWord();
    const asksForMeaning = state.position % 2 === 0;
    const field = asksForMeaning ? "meaning" : "hanzi";
    const answer = word[field];
    const distractors = shuffle(
      [...new Set(words.filter((item) => item[field] !== answer).map((item) => item[field]))]
    ).slice(0, 3);
    return { asksForMeaning, answer, choices: shuffle([answer, ...distractors]) };
  }

  function renderQuiz() {
    const word = currentWord();
    const quiz = makeQuiz();
    elements.studyArea.innerHTML = `
      <div class="quiz-wrap">
        <p class="question-label">${quiz.asksForMeaning ? "Chọn nghĩa đúng" : "Chọn chữ Hán đúng"}</p>
        ${quiz.asksForMeaning
          ? `<p class="question-word"><strong>${escapeHtml(word.hanzi)}</strong><span>${escapeHtml(word.pinyin)}</span></p>`
          : `<p class="write-prompt">${escapeHtml(word.meaning)}</p><p class="write-help">Chọn từ phù hợp với nghĩa trên</p>`}
        <div class="choices">
          ${quiz.choices.map((choice) => `<button class="choice-button ${quiz.asksForMeaning ? "" : "hanzi-choice"}" type="button" data-answer="${escapeHtml(choice)}">${escapeHtml(choice)}</button>`).join("")}
        </div>
        <p class="feedback" id="feedback" aria-live="assertive"></p>
      </div>`;

    document.querySelectorAll(".choice-button").forEach((button) => {
      button.addEventListener("click", () => {
        if (state.answered) return;
        state.answered = true;
        const isCorrect = button.dataset.answer === quiz.answer;
        if (isCorrect) state.correct += 1;
        recordResult(word, isCorrect);
        document.querySelectorAll(".choice-button").forEach((item) => {
          item.disabled = true;
          if (item.dataset.answer === quiz.answer) item.classList.add("is-correct");
        });
        if (!isCorrect) button.classList.add("is-wrong");
        const feedback = document.querySelector("#feedback");
        feedback.textContent = isCorrect ? "Chính xác!" : `Đáp án đúng: ${quiz.answer}`;
        feedback.className = `feedback ${isCorrect ? "correct" : "wrong"}`;
        updateProgressBar();
      });
    });
  }

  function normalizeAnswer(value) {
    return value
      .normalize("NFKC")
      .replace(/[\s。！？!?，,、/;；：“”"'\-—_()[\]（）…+=]/g, "")
      .toLowerCase();
  }

  function acceptedWrittenAnswers(hanzi) {
    const options = new Set([hanzi]);
    hanzi.split(/[\/、，,]/).forEach((item) => options.add(item));
    for (const match of hanzi.matchAll(/[（(]([^）)]+)[）)]/g)) options.add(match[1]);
    options.add(hanzi.replace(/[（(][^）)]+[）)]/g, ""));
    return [...options].map(normalizeAnswer).filter(Boolean);
  }

  function renderWrite() {
    const word = currentWord();
    elements.studyArea.innerHTML = `
      <div class="write-wrap">
        <p class="question-label">Gõ chữ Hán phù hợp</p>
        <p class="write-prompt">${escapeHtml(word.meaning)}</p>
        <p class="write-help">Nhập đáp án rồi nhấn Enter để kiểm tra</p>
        <form class="answer-form" id="answerForm">
          <label class="sr-only" for="answerInput">Đáp án bằng chữ Hán</label>
          <input class="answer-input" id="answerInput" type="text" inputmode="text" autocomplete="off" autocapitalize="none" placeholder="Nhập chữ Hán…" />
          <button class="primary-button" type="submit">Kiểm tra</button>
        </form>
        <div id="writeFeedback" aria-live="assertive"></div>
      </div>`;

    const form = document.querySelector("#answerForm");
    const input = document.querySelector("#answerInput");
    input.focus({ preventScroll: true });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.answered || !input.value.trim()) return;
      state.answered = true;
      const isCorrect = acceptedWrittenAnswers(word.hanzi).includes(normalizeAnswer(input.value));
      if (isCorrect) state.correct += 1;
      recordResult(word, isCorrect);
      input.disabled = true;
      form.querySelector("button").disabled = true;
      document.querySelector("#writeFeedback").innerHTML = `
        <p class="feedback ${isCorrect ? "correct" : "wrong"}">${isCorrect ? "Chính xác!" : "Chưa đúng. Đáp án là:"}</p>
        <div class="answer-result"><strong>${escapeHtml(word.hanzi)}</strong><span>${escapeHtml(word.pinyin)} · ${escapeHtml(word.meaning)}</span></div>`;
      updateProgressBar();
    });
  }

  function render() {
    updateStats();
    updateProgressBar();
    const total = state.activeIndices.length;
    elements.previousButton.disabled = !total || state.position === 0;
    elements.nextButton.disabled = !total;
    elements.nextButton.innerHTML = state.position === total - 1 ? "Học lại từ đầu <span aria-hidden=\"true\">↻</span>" : "Từ tiếp <span aria-hidden=\"true\">→</span>";
    elements.sessionStatus.textContent = state.mode === "flashcard" ? "Chạm vào thẻ để lật" : state.mode === "quiz" ? "Chọn một đáp án" : "Gõ đáp án bằng chữ Hán";
    if (!total) return renderEmpty();
    if (state.mode === "flashcard") renderFlashcard();
    if (state.mode === "quiz") renderQuiz();
    if (state.mode === "write") renderWrite();
  }

  function goNext() {
    const total = state.activeIndices.length;
    if (!total) return;
    state.position = state.position === total - 1 ? 0 : state.position + 1;
    state.flipped = false;
    state.answered = false;
    render();
  }

  function goPrevious() {
    if (state.position === 0) return;
    state.position -= 1;
    state.flipped = false;
    state.answered = false;
    render();
  }

  function shuffleDeck() {
    state.activeIndices = shuffle(state.activeIndices);
    state.position = 0;
    state.flipped = false;
    state.answered = false;
    render();
    showToast("Đã xáo trộn nhóm từ đang học.");
  }

  function recordResult(word, isCorrect) {
    const key = wordKey(word);
    const previous = state.progress.get(key) || sanitizeProgress({});
    const streak = isCorrect ? previous.streak + 1 : 0;
    const intervalDays = streak <= 1 ? 1 : streak === 2 ? 3 : 7;
    const now = new Date();
    const nextReview = new Date(now);
    if (isCorrect) nextReview.setDate(nextReview.getDate() + intervalDays);

    const progress = {
      status: isCorrect && streak >= 3 ? "mastered" : "learning",
      attempts: previous.attempts + 1,
      correctCount: previous.correctCount + (isCorrect ? 1 : 0),
      wrongCount: previous.wrongCount + (isCorrect ? 0 : 1),
      streak,
      lastResult: isCorrect ? "correct" : "wrong",
      lastReviewedAt: now.toISOString(),
      nextReviewAt: nextReview.toISOString(),
      updatedAt: now.toISOString()
    };
    state.progress.set(key, progress);
    saveLocalProgress();
    updateStats();
    void syncProgressRecord(key, progress);
  }

  function toDatabaseRow(key, progress) {
    return {
      user_id: state.session.user.id,
      word_key: key,
      status: progress.status,
      attempts: progress.attempts,
      correct_count: progress.correctCount,
      wrong_count: progress.wrongCount,
      streak: progress.streak,
      last_result: progress.lastResult,
      last_reviewed_at: progress.lastReviewedAt,
      next_review_at: progress.nextReviewAt,
      updated_at: progress.updatedAt
    };
  }

  async function syncProgressRecord(key, progress) {
    if (!supabaseClient || !state.session?.user) return;
    state.syncing = true;
    setSyncState("syncing", "Đang đồng bộ…");
    const { error } = await supabaseClient
      .from("user_word_progress")
      .upsert(toDatabaseRow(key, progress), { onConflict: "user_id,word_key" });
    state.syncing = false;
    if (error) {
      setSyncState("error", "Chưa đồng bộ");
      showToast("Không đồng bộ được tiến độ. Dữ liệu vẫn được giữ trên máy.");
      return;
    }
    setSyncState("cloud", "Đã đồng bộ");
  }

  async function loadCloudProgress() {
    if (!supabaseClient || !state.session?.user) return;
    setSyncState("syncing", "Đang đồng bộ…");
    const { data, error } = await supabaseClient.from("user_word_progress").select("*");
    if (error) {
      state.progress = readLocalProgress(state.session.user.id);
      applyQueue(state.queue);
      setSyncState("error", "Chưa đồng bộ");
      showToast("Không đọc được dữ liệu Supabase. Đang dùng bản lưu trên máy.");
      return;
    }

    const remote = new Map(
      (data || [])
        .filter((row) => validWordKeys.has(row.word_key))
        .map((row) => [row.word_key, sanitizeProgress(row)])
    );
    const cached = readLocalProgress(state.session.user.id);
    cached.forEach((value, key) => {
      const remoteValue = remote.get(key);
      if (!remoteValue || new Date(value.updatedAt) > new Date(remoteValue.updatedAt)) remote.set(key, value);
    });

    if (remote.size === 0) {
      const guest = readLocalProgress(null);
      guest.forEach((value, key) => remote.set(key, value));
    }

    state.progress = remote;
    saveLocalProgress();
    if (remote.size) {
      const rows = [...remote].map(([key, value]) => toDatabaseRow(key, value));
      const { error: upsertError } = await supabaseClient
        .from("user_word_progress")
        .upsert(rows, { onConflict: "user_id,word_key" });
      if (upsertError) {
        setSyncState("error", "Chưa đồng bộ");
        applyQueue(state.queue);
        return;
      }
    }
    setSyncState("cloud", "Đã đồng bộ");
    applyQueue(state.queue);
  }

  function renderAccountState() {
    const user = state.session?.user;
    elements.signedOutView.hidden = Boolean(user);
    elements.signedInView.hidden = !user;
    elements.accountButtonText.textContent = user ? "Tài khoản" : "Đăng nhập";
    if (user) {
      elements.accountEmail.textContent = user.email || "Tài khoản Supabase";
      elements.accountSyncStatus.textContent = "Tiến độ được đồng bộ giữa các thiết bị khi có mạng.";
      if (!state.syncing) setSyncState("cloud", "Đã đồng bộ");
    } else {
      setSyncState("local", "Lưu trên máy");
      if (!hasSupabaseConfig) {
        elements.authMessage.textContent = "Website đang chờ cấu hình Supabase để bật đăng nhập.";
        elements.authMessage.className = "form-message info";
        elements.authSubmitButton.disabled = true;
      } else {
        elements.authSubmitButton.disabled = false;
      }
    }
  }

  function setAuthMode(mode) {
    state.authMode = mode === "signup" ? "signup" : "login";
    authTabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.authMode === state.authMode));
    elements.authSubmitButton.textContent = state.authMode === "login" ? "Đăng nhập" : "Tạo tài khoản";
    elements.passwordInput.autocomplete = state.authMode === "login" ? "current-password" : "new-password";
    if (hasSupabaseConfig) elements.authMessage.textContent = "";
  }

  function readableAuthError(error) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("invalid login credentials")) return "Email hoặc mật khẩu chưa đúng.";
    if (message.includes("already registered")) return "Email này đã được đăng ký.";
    if (message.includes("password")) return "Mật khẩu chưa đạt yêu cầu của Supabase.";
    if (message.includes("rate")) return "Bạn thao tác quá nhanh. Vui lòng thử lại sau.";
    return error?.message || "Không thể xử lý yêu cầu lúc này.";
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!supabaseClient) return;
    const email = elements.emailInput.value.trim();
    const password = elements.passwordInput.value;
    elements.authSubmitButton.disabled = true;
    elements.authSubmitButton.textContent = "Đang xử lý…";
    elements.authMessage.textContent = "";

    const result = state.authMode === "signup"
      ? await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })
      : await supabaseClient.auth.signInWithPassword({ email, password });

    elements.authSubmitButton.disabled = false;
    elements.authSubmitButton.textContent = state.authMode === "login" ? "Đăng nhập" : "Tạo tài khoản";
    if (result.error) {
      elements.authMessage.textContent = readableAuthError(result.error);
      elements.authMessage.className = "form-message error";
      return;
    }
    if (state.authMode === "signup" && !result.data.session) {
      elements.authMessage.textContent = "Đã tạo tài khoản. Hãy kiểm tra email để xác nhận rồi đăng nhập.";
      elements.authMessage.className = "form-message success";
      return;
    }
    elements.accountDialog.close();
    showToast("Đăng nhập thành công. Đang đồng bộ tiến độ…");
  }

  async function signOut() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    elements.accountDialog.close();
    showToast("Đã đăng xuất. Trang chuyển về tiến độ trên thiết bị này.");
  }

  async function resetProgress() {
    const confirmed = window.confirm("Xóa toàn bộ tiến độ đã học? Thao tác này không thể hoàn tác.");
    if (!confirmed) return;
    if (supabaseClient && state.session?.user) {
      const { error } = await supabaseClient
        .from("user_word_progress")
        .delete()
        .eq("user_id", state.session.user.id);
      if (error) {
        showToast("Chưa thể xóa tiến độ trên Supabase.");
        return;
      }
    }
    state.progress.clear();
    localStorage.removeItem(storageKey());
    applyQueue("today");
    elements.accountDialog.close();
    showToast("Đã xóa toàn bộ tiến độ học.");
  }

  function resetGuestProgress() {
    const confirmed = window.confirm("Xóa toàn bộ tiến độ đang lưu trên thiết bị này?");
    if (!confirmed) return;
    state.progress.clear();
    localStorage.removeItem(storageKey(null));
    applyQueue("today");
    elements.accountDialog.close();
    showToast("Đã xóa tiến độ lưu trên thiết bị này.");
  }

  async function initAuth() {
    state.progress = readLocalProgress(null);
    applyQueue("today");
    if (!supabaseClient) {
      renderAccountState();
      return;
    }

    const { data } = await supabaseClient.auth.getSession();
    state.session = data.session;
    renderAccountState();
    if (state.session) await loadCloudProgress();

    supabaseClient.auth.onAuthStateChange((event, session) => {
      const previousUserId = state.session?.user?.id;
      state.session = session;
      renderAccountState();
      if (session?.user && session.user.id !== previousUserId) {
        setTimeout(() => void loadCloudProgress(), 0);
      }
      if (!session?.user && previousUserId) {
        state.progress = readLocalProgress(null);
        applyQueue("today");
      }
    });
  }

  modeTabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));
  queueTabs.forEach((tab) => tab.addEventListener("click", () => applyQueue(tab.dataset.queue)));
  authTabs.forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode)));
  elements.previousButton.addEventListener("click", goPrevious);
  elements.nextButton.addEventListener("click", goNext);
  elements.shuffleButton.addEventListener("click", shuffleDeck);
  elements.accountButton.addEventListener("click", () => elements.accountDialog.showModal());
  elements.closeAccountButton.addEventListener("click", () => elements.accountDialog.close());
  elements.accountDialog.addEventListener("click", (event) => {
    if (event.target === elements.accountDialog) elements.accountDialog.close();
  });
  elements.authForm.addEventListener("submit", handleAuthSubmit);
  elements.logoutButton.addEventListener("click", signOut);
  elements.resetProgressButton.addEventListener("click", resetProgress);
  elements.resetGuestProgressButton.addEventListener("click", resetGuestProgress);

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input")) return;
    if (event.code === "Space" && state.mode === "flashcard" && currentWord()) {
      event.preventDefault();
      state.flipped = !state.flipped;
      renderFlashcard();
    }
    if (event.key === "ArrowRight") goNext();
    if (event.key === "ArrowLeft") goPrevious();
  });

  function registerWebMcpTools() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    try {
      void Promise.resolve(context.registerTool({
        name: "start_study_mode",
        title: "Bắt đầu chế độ học",
        description: "Mở chế độ thẻ lật, trắc nghiệm hoặc tự luận.",
        inputSchema: {
          type: "object",
          properties: { mode: { type: "string", enum: ["flashcard", "quiz", "write"] } },
          required: ["mode"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || !setMode(input.mode)) throw new Error("Chế độ học không hợp lệ.");
          return { mode: state.mode, queue: state.queue, totalWords: state.activeIndices.length };
        }
      })).catch(() => {});

      void Promise.resolve(context.registerTool({
        name: "start_review_queue",
        title: "Chọn nhóm từ cần ôn",
        description: "Mở nhóm học hôm nay, từ sai, tất cả từ hoặc từ đã nhớ.",
        inputSchema: {
          type: "object",
          properties: { queue: { type: "string", enum: ["today", "wrong", "all", "mastered"] } },
          required: ["queue"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || !applyQueue(input.queue)) throw new Error("Nhóm từ không hợp lệ.");
          return { queue: state.queue, totalWords: state.activeIndices.length };
        }
      })).catch(() => {});

      void Promise.resolve(context.registerTool({
        name: "get_study_status",
        title: "Xem tiến độ học",
        description: "Đọc chế độ và tiến độ hiện tại mà không thay đổi bài học.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute() {
          const learned = [...state.progress.values()];
          return {
            mode: state.mode,
            queue: state.queue,
            totalWords: state.activeIndices.length,
            currentWord: state.position + 1,
            studied: learned.length,
            mastered: learned.filter((item) => item.status === "mastered").length,
            signedIn: Boolean(state.session?.user)
          };
        }
      })).catch(() => {});
    } catch (_) {
      // WebMCP is optional; the visible study interface remains fully functional.
    }
  }

  registerWebMcpTools();
  void initAuth();
})();
