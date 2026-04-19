const fs = require('node:fs');
const path = require('node:path');

function resolveTriviaDataPath() {
  const envPath = process.env.TRIVIA_DATA_PATH;
  if (typeof envPath === 'string' && envPath.trim() !== '') {
    return path.resolve(process.cwd(), envPath);
  }

  return path.resolve(process.cwd(), 'data', 'trivia_questions.json');
}

function normalizeQuestion(rawQuestion) {
  if (!rawQuestion || typeof rawQuestion !== 'object') return null;

  const prompt = typeof rawQuestion.question === 'string'
    ? rawQuestion.question.trim()
    : typeof rawQuestion.prompt === 'string'
      ? rawQuestion.prompt.trim()
      : '';

  const acceptedAnswers = [];
  const pushAnswer = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!acceptedAnswers.includes(trimmed)) acceptedAnswers.push(trimmed);
  };

  if (typeof rawQuestion.answer === 'string') {
    pushAnswer(rawQuestion.answer);
  } else if (Array.isArray(rawQuestion.answer)) {
    rawQuestion.answer.forEach(pushAnswer);
  }

  if (Array.isArray(rawQuestion.acceptedAnswers)) rawQuestion.acceptedAnswers.forEach(pushAnswer);
  if (Array.isArray(rawQuestion.aliases)) rawQuestion.aliases.forEach(pushAnswer);

  if (!prompt || acceptedAnswers.length === 0) return null;

  return {
    prompt,
    canonicalAnswer: acceptedAnswers[0],
    acceptedAnswers,
    explanation: typeof rawQuestion.explanation === 'string' ? rawQuestion.explanation.trim() : ''
  };
}

function loadTriviaData(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      data: { categories: [] },
      categories: [],
      categoryById: new Map()
    };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  const rawCategories = Array.isArray(data && data.categories) ? data.categories : [];
  const categories = [];

  for (const rawCategory of rawCategories) {
    if (!rawCategory || typeof rawCategory !== 'object') continue;

    const id = typeof rawCategory.id === 'string' ? rawCategory.id.trim() : '';
    const label = typeof rawCategory.label === 'string' ? rawCategory.label.trim() : '';
    if (!id || !label) continue;

    const questions = Array.isArray(rawCategory.questions)
      ? rawCategory.questions.map(normalizeQuestion).filter(Boolean)
      : [];

    categories.push({
      id,
      label,
      description: typeof rawCategory.description === 'string' ? rawCategory.description.trim() : '',
      questions
    });
  }

  const categoryById = new Map();
  for (const category of categories) categoryById.set(category.id, category);

  return {
    filePath,
    exists: true,
    data,
    categories,
    categoryById
  };
}

module.exports = {
  loadTriviaData,
  resolveTriviaDataPath
};