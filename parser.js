/**
 * QuizPro HTML Question Parser
 * An adaptive parsing engine to extract questions, options, correct answers, and explanations from raw HTML.
 */

class QuizParser {
    /**
     * Parses an HTML string into structured question objects.
     * @param {string} htmlText - The raw HTML content.
     * @param {Object} [customConfig] - Optional selector overrides.
     * @returns {Array<Object>} List of questions parsed.
     */
    static parse(htmlText, customConfig = {}, answerKeyText = '') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        
        const config = {
            questionBlockSelector: customConfig.questionBlockSelector || '',
            questionTextSelector: customConfig.questionTextSelector || '',
            optionSelector: customConfig.optionSelector || '',
            correctIndicatorSelector: customConfig.correctIndicatorSelector || '',
            explanationSelector: customConfig.explanationSelector || '',
            ...customConfig
        };

        // If user specified custom selectors, use standard structured extraction
        let questions = [];
        if (config.questionBlockSelector) {
            questions = this.parseWithSelectors(doc, config);
        } else {
            // Otherwise, fall back to our smart adaptive parser
            questions = this.adaptiveParse(doc);
        }

        // Apply answer key if provided
        if (answerKeyText) {
            const answerMap = this.parseAnswerKey(answerKeyText);
            questions.forEach((q, idx) => {
                const qNum = idx + 1;
                if (answerMap[qNum] !== undefined) {
                    const resolvedIdx = this.resolveCorrectAnswer(answerMap[qNum], q.options);
                    if (resolvedIdx !== -1) {
                        q.correctAnswerIndex = resolvedIdx;
                    }
                }
            });
        }

        return questions;
    }

    /**
     * Parse using specific user-defined selectors
     */
    static parseWithSelectors(doc, config) {
        const questions = [];
        const blocks = doc.querySelectorAll(config.questionBlockSelector);
        
        blocks.forEach((block, index) => {
            // Find question text
            let questionText = '';
            if (config.questionTextSelector) {
                const qEl = block.querySelector(config.questionTextSelector);
                questionText = qEl ? qEl.innerHTML.trim() : '';
            } else {
                // Fallback inside block: first candidate that isn't just "Question X" heading
                const candidateEls = Array.from(block.querySelectorAll('h1, h2, h3, h4, h5, h6, p, .question-text, .q-text, strong'));
                for (const el of candidateEls) {
                    const txt = el.textContent.trim();
                    if (txt && !/^\s*(?:Question|Q\.?)\s*\d+\s*$/i.test(txt)) {
                        questionText = el.innerHTML.trim();
                        break;
                    }
                }
                if (!questionText) {
                    const qEl = block.querySelector('h1, h2, h3, h4, h5, h6, p, .question-text, .q-text');
                    questionText = qEl ? qEl.innerHTML.trim() : (block.firstChild ? block.firstChild.textContent.trim() : '');
                }
            }

            // Find options
            let options = [];
            let correctAnswerIndex = -1;
            
            if (config.optionSelector) {
                const optEls = block.querySelectorAll(config.optionSelector);
                optEls.forEach((optEl) => {
                    const text = optEl.textContent.trim();
                    if (this.isPlaceholderOrEmptyOption(text)) {
                        return;
                    }
                    const optText = this.cleanOptionText(optEl.textContent);
                    options.push(optText);
                    
                    // Check if correct
                    if (config.correctIndicatorSelector && optEl.matches(config.correctIndicatorSelector)) {
                        correctAnswerIndex = options.length - 1;
                    } else if (this.hasCorrectTextIndicator(optEl.textContent) || optEl.classList.contains('correct') || optEl.classList.contains('answer')) {
                        correctAnswerIndex = options.length - 1;
                    }
                });
            } else {
                // Fallback option finding within block
                const res = this.findOptionsInContainer(block);
                options = res.options;
                correctAnswerIndex = res.correctAnswerIndex;
            }

            // Find explanation
            let explanation = '';
            if (config.explanationSelector) {
                const expEl = block.querySelector(config.explanationSelector);
                explanation = expEl ? expEl.innerHTML.trim() : '';
            } else {
                const expEl = block.querySelector('.explanation, .exp, .solution, .sol, blockquote');
                explanation = expEl ? expEl.innerHTML.trim() : '';
            }

            // Try to find correct answer from text patterns if not found yet
            if (correctAnswerIndex === -1) {
                correctAnswerIndex = this.findCorrectAnswerFromTextPatterns(block.textContent, options);
            }

            if (questionText && options.length > 0) {
                questions.push({
                    id: `q-${index}-${Date.now()}`,
                    questionText: this.cleanQuestionText(questionText),
                    options,
                    correctAnswerIndex,
                    explanation,
                    isFIB: block.textContent.toLowerCase().includes('fib') || options.length === 1
                });
            }
        });

        return questions;
    }

    /**
     * Smart adaptive parser for generic, un-styled HTML documents.
     */
    static adaptiveParse(doc) {
        const questions = [];
        
        // 1. Try to find blocks using common question container class selectors
        const commonBlockSelectors = [
            '.question-block', '.mcq-card', '.question-card', '.mcq', 
            '.question-container', '.quiz-card', '.question-item', '.question'
        ];
        
        let blocks = [];
        for (const selector of commonBlockSelectors) {
            const found = doc.querySelectorAll(selector);
            // Ensure these cards aren't just the whole quiz body itself
            if (found.length > 0 && found.length < doc.body.querySelectorAll('*').length / 3) {
                blocks = Array.from(found);
                break;
            }
        }

        if (blocks.length > 0) {
            // Parse using blocks
            blocks.forEach((block, index) => {
                // Find all candidate text elements inside the block
                const candidateEls = Array.from(block.querySelectorAll('h1, h2, h3, h4, h5, h6, p, .question-text, .q-text, strong'));
                let questionText = '';
                
                for (const el of candidateEls) {
                    const txt = el.textContent.trim();
                    if (txt && !/^\s*(?:Question|Q\.?)\s*\d+\s*$/i.test(txt)) {
                        questionText = el.innerHTML.trim();
                        break;
                    }
                }

                if (!questionText) {
                    const qEl = block.querySelector('h1, h2, h3, h4, h5, h6, p, .question-text, .q-text, strong');
                    questionText = qEl ? qEl.innerHTML.trim() : block.textContent.split('\n')[0].trim();
                }
                
                const { options, correctAnswerIndex } = this.findOptionsInContainer(block);
                
                const expEl = block.querySelector('.explanation, .exp, .solution, .sol, blockquote');
                const explanation = expEl ? expEl.innerHTML.trim() : '';

                let finalCorrectIdx = correctAnswerIndex;
                if (finalCorrectIdx === -1) {
                    finalCorrectIdx = this.findCorrectAnswerFromTextPatterns(block.textContent, options);
                }

                if (questionText && options.length > 0) {
                    questions.push({
                        id: `q-${index}-${Date.now()}`,
                        questionText: this.cleanQuestionText(questionText),
                        options,
                        correctAnswerIndex: finalCorrectIdx,
                        explanation,
                        isFIB: block.textContent.toLowerCase().includes('fib') || options.length === 1
                    });
                }
            });
            
            if (questions.length > 0) return questions;
        }

        // 2. If no block containers, parse linearly by searching for question headers/paragraphs
        // Look for headings, paragraphs or divs that start with numbers (e.g., "1.", "Question 1:")
        const elements = Array.from(doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, li'));
        const questionCandidates = [];

        elements.forEach(el => {
            const text = el.textContent.trim();
            // Match "Question 1", "Q1", "1.", "1)" but make sure it isn't an option list item
            if (this.isQuestionHeadingText(text)) {
                questionCandidates.push(el);
            }
        });

        // Parse questions relative to candidates
        questionCandidates.forEach((qEl, index) => {
            let questionText = qEl.innerHTML.trim();
            const options = [];
            let correctAnswerIndex = -1;
            let explanation = '';
            
            // Collect sibling elements until the next question or end of container
            const siblingElements = [];
            let sibling = qEl.nextElementSibling;
            const nextQuestionEl = questionCandidates[index + 1];
            
            while (sibling && sibling !== nextQuestionEl) {
                siblingElements.push(sibling);
                sibling = sibling.nextElementSibling;
            }

            // Sibling preprocessing for heading placeholders (e.g. "Question 1")
            const isJustHeading = /^\s*(?:Question|Q\.?)\s*\d+\s*$/i.test(qEl.textContent.trim());
            if (isJustHeading && siblingElements.length > 0) {
                let questionTextSiblingIndex = -1;
                for (let i = 0; i < siblingElements.length; i++) {
                    const sib = siblingElements[i];
                    const text = sib.textContent.trim();
                    if (sib.tagName !== 'UL' && sib.tagName !== 'OL' && !this.isOptionText(text) && text) {
                        questionText = sib.innerHTML.trim();
                        questionTextSiblingIndex = i;
                        break;
                    }
                }
                if (questionTextSiblingIndex !== -1) {
                    siblingElements.splice(questionTextSiblingIndex, 1);
                }
            }
            
            // Check collected sibling elements for options, explanations, and key answers
            let blockText = '';
            siblingElements.forEach(sib => {
                blockText += ' ' + sib.textContent;
                
                // Parse lists
                if (sib.tagName === 'UL' || sib.tagName === 'OL') {
                    const lis = sib.querySelectorAll('li');
                    lis.forEach((li) => {
                        const rawText = li.textContent.trim();
                        if (this.isPlaceholderOrEmptyOption(rawText)) {
                            return;
                        }
                        options.push(this.cleanOptionText(li.textContent));
                        if (this.hasCorrectTextIndicator(li.textContent) || li.querySelector('strong') && this.hasCorrectTextIndicator(li.querySelector('strong').textContent)) {
                            correctAnswerIndex = options.length - 1;
                        }
                    });
                } 
                // Parse standalone options
                else if (this.isOptionText(sib.textContent)) {
                    const rawText = sib.textContent.trim();
                    if (this.isPlaceholderOrEmptyOption(rawText)) {
                        return;
                    }
                    options.push(this.cleanOptionText(sib.textContent));
                    if (this.hasCorrectTextIndicator(sib.textContent)) {
                        correctAnswerIndex = options.length - 1;
                    }
                }
                
                // Parse explanation
                if (sib.classList.contains('explanation') || sib.classList.contains('exp') || 
                    sib.classList.contains('solution') || sib.textContent.toLowerCase().includes('explanation:') ||
                    sib.tagName === 'BLOCKQUOTE') {
                    explanation += sib.innerHTML.trim() + ' ';
                }
            });

            // If we didn't find standard list/options structure, look inside the siblings for text
            if (options.length === 0) {
                // Let's parse text options (lines starting with A, B, C, D) inside siblings
                const lines = blockText.split('\n');
                lines.forEach(line => {
                    if (this.isOptionText(line) && !this.isPlaceholderOrEmptyOption(line)) {
                        options.push(this.cleanOptionText(line));
                        if (this.hasCorrectTextIndicator(line)) {
                            correctAnswerIndex = options.length - 1;
                        }
                    }
                });
            }

            // Fallback: look for Answer pattern in the sibling text block
            if (correctAnswerIndex === -1) {
                correctAnswerIndex = this.findCorrectAnswerFromTextPatterns(blockText, options);
            }

            if (questionText && options.length > 0) {
                questions.push({
                    id: `q-${index}-${Date.now()}`,
                    questionText: this.cleanQuestionText(questionText),
                    options,
                    correctAnswerIndex,
                    explanation: explanation.trim(),
                    isFIB: qEl.textContent.toLowerCase().includes('fib') || blockText.toLowerCase().includes('fib') || options.length === 1
                });
            }
        });

        // 3. Absolute fallback: If still empty, scan body line-by-line (for plain text pasted in HTML)
        if (questions.length === 0) {
            const bodyLines = doc.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            let currentQuestion = null;

            bodyLines.forEach(line => {
                if (this.isQuestionHeadingText(line)) {
                    if (currentQuestion && currentQuestion.options.length > 0) {
                        currentQuestion.isFIB = currentQuestion.questionText.toLowerCase().includes('fib') || currentQuestion.options.length === 1;
                        questions.push(currentQuestion);
                    }
                    currentQuestion = {
                        id: `q-${questions.length}-${Date.now()}`,
                        questionText: this.cleanQuestionText(line),
                        options: [],
                        correctAnswerIndex: -1,
                        explanation: '',
                        isFIB: false
                    };
                } else if (currentQuestion && this.isOptionText(line)) {
                    currentQuestion.options.push(this.cleanOptionText(line));
                    if (this.hasCorrectTextIndicator(line)) {
                        currentQuestion.correctAnswerIndex = currentQuestion.options.length - 1;
                    }
                } else if (currentQuestion) {
                    // Check if it's answer key or explanation
                    if (line.toLowerCase().startsWith('answer:') || line.toLowerCase().startsWith('correct answer:')) {
                        const match = line.match(/(?:correct\s+)?answer:\s*([A-D])/i);
                        if (match) {
                            const letter = match[1].toUpperCase();
                            currentQuestion.correctAnswerIndex = letter.charCodeAt(0) - 65;
                        }
                    } else if (line.toLowerCase().startsWith('explanation:')) {
                        currentQuestion.explanation = line.replace(/^explanation:\s*/i, '');
                    }
                }
            });

            if (currentQuestion && currentQuestion.options.length > 0) {
                currentQuestion.isFIB = currentQuestion.questionText.toLowerCase().includes('fib') || currentQuestion.options.length === 1;
                questions.push(currentQuestion);
            }
        }

        return questions;
    }

    /**
     * Helpers for detecting formatting structures
     */
    static isQuestionHeadingText(text) {
        // Matches e.g. "Question 1: ...", "Q2. ...", "12. ...", "1) ..."
        const qRegex = /^\s*(?:Question|Q\.?|)\s*\d+[\s.:\)-]/i;
        return qRegex.test(text) && text.length > 5 && text.length < 500;
    }

    static isOptionText(text) {
        // Matches e.g. "A) Earth", "B. Mars", "C - Jupiter", "a) Option"
        const optRegex = /^\s*[A-D]\s*[\.:\)-]/i;
        return optRegex.test(text);
    }

    static hasCorrectTextIndicator(text) {
        // Matches text ending in or containing (Correct), [Correct], (Ans), [Ans]
        const indicatorRegex = /[\(\[]\s*(?:correct|ans|right|correct\s+answer)\s*[\)\]]/i;
        return indicatorRegex.test(text);
    }

    static cleanQuestionText(html) {
        // Strip question prefixes like "Question 1:", "Q1. ", etc.
        let clean = html.replace(/^\s*(?:Question|Q\.?|)\s*\d+\s*[\s.:\)-]\s*/i, '').trim();
        // Remove trailing elements if they are just decorations
        return clean;
    }

    static cleanOptionText(text) {
        // Strip prefixes like "A) ", "B. ", "1. ", "a) "
        let clean = text.replace(/^\s*[A-D\d]\s*[\.:\)-]\s*/i, '');
        // Strip indicators like " (Correct)" or " [Ans]"
        clean = clean.replace(/\s*[\(\[]\s*(?:correct|ans|right|correct\s+answer)\s*[\)\]]\s*$/i, '');
        return clean.trim();
    }

    static isPlaceholderOrEmptyOption(text) {
        const clean = this.cleanOptionText(text);
        if (!clean) return true;

        const lower = text.toLowerCase().trim();
        if (lower.startsWith('answer:') && lower.replace('answer:', '').trim().length === 0) return true;
        if (lower.startsWith('solution:') && lower.replace('solution:', '').trim().length === 0) return true;
        if (lower.startsWith('explanation:') && lower.replace('explanation:', '').trim().length === 0) return true;

        return false;
    }

    static findOptionsInContainer(container) {
        const options = [];
        let correctAnswerIndex = -1;

        // Try radio button inputs first
        const radios = container.querySelectorAll('input[type="radio"]');
        if (radios.length > 0) {
            radios.forEach((radio) => {
                // Find associated label or parent text
                let labelText = '';
                if (radio.id) {
                    const label = container.querySelector(`label[for="${radio.id}"]`);
                    if (label) labelText = label.textContent;
                }
                if (!labelText) {
                    labelText = radio.parentElement.textContent.replace(radio.textContent, '');
                }

                const rawText = labelText.trim();
                if (this.isPlaceholderOrEmptyOption(rawText)) {
                    return;
                }

                options.push(this.cleanOptionText(labelText));
                if (radio.checked || radio.hasAttribute('checked') || radio.parentElement.classList.contains('correct')) {
                    correctAnswerIndex = options.length - 1;
                }
            });
            if (options.length > 0) return { options, correctAnswerIndex };
        }

        // Try lists (li)
        const lis = container.querySelectorAll('li');
        if (lis.length > 0) {
            lis.forEach((li) => {
                const rawText = li.textContent.trim();
                if (this.isPlaceholderOrEmptyOption(rawText)) {
                    return;
                }
                options.push(this.cleanOptionText(li.textContent));
                if (this.hasCorrectTextIndicator(li.textContent) || li.classList.contains('correct') || li.classList.contains('answer')) {
                    correctAnswerIndex = options.length - 1;
                }
            });
            return { options, correctAnswerIndex };
        }

        // Try custom class list `.option-item` or similar
        const optionClasses = ['.option-item', '.option', '.opt', '.ans-item'];
        for (const optClass of optionClasses) {
            const optEls = container.querySelectorAll(optClass);
            if (optEls.length > 0) {
                optEls.forEach((optEl) => {
                    const rawText = optEl.textContent.trim();
                    if (this.isPlaceholderOrEmptyOption(rawText)) {
                        return;
                    }
                    options.push(this.cleanOptionText(optEl.textContent));
                    if (optEl.classList.contains('correct') || optEl.classList.contains('right') || this.hasCorrectTextIndicator(optEl.textContent)) {
                        correctAnswerIndex = options.length - 1;
                    }
                });
                return { options, correctAnswerIndex };
            }
        }

        // Try finding generic child elements that start with option letters
        const children = Array.from(container.querySelectorAll('div, p, span'));
        children.forEach(child => {
            const text = child.textContent.trim();
            if (this.isOptionText(text) && !this.isPlaceholderOrEmptyOption(text)) {
                options.push(this.cleanOptionText(text));
                if (this.hasCorrectTextIndicator(text) || child.classList.contains('correct')) {
                    correctAnswerIndex = options.length - 1;
                }
            }
        });

        return { options, correctAnswerIndex };
    }

    static findCorrectAnswerFromTextPatterns(text, options) {
        // Try to search text for "Answer: C", "Correct Answer: B", "Ans: A"
        const answerPatterns = [
            /(?:correct\s+)?answer:\s*([A-D])/i,
            /ans:\s*([A-D])/i,
            /key:\s*([A-D])/i,
            /(?:correct\s+)?option\s+([A-D])\s+is\s+correct/i,
            /correct\s+is\s+([A-D])/i
        ];

        for (const pattern of answerPatterns) {
            const match = text.match(pattern);
            if (match) {
                const letter = match[1].toUpperCase();
                const index = letter.charCodeAt(0) - 65; // A=0, B=1, C=2, D=3
                if (index >= 0 && index < options.length) {
                    return index;
                }
            }
        }

        // If no explicit letter answer, check if any option matches a text phrase like "Answer: Mars"
        const answerValPattern = /(?:correct\s+)?answer:\s*([^\n\.]+)/i;
        const matchVal = text.match(answerValPattern);
        if (matchVal) {
            const val = matchVal[1].toLowerCase().trim();
            for (let i = 0; i < options.length; i++) {
                if (options[i].toLowerCase().trim() === val || val.includes(options[i].toLowerCase().trim())) {
                    return i;
                }
            }
        }

        return -1;
    }

    /**
     * Parses an answer key text file contents into a mapping.
     */
    static parseAnswerKey(txtText) {
        const cleanedText = txtText.trim();
        const answers = {};

        // Support single-line double-pipe "||" separated values (e.g. 15||74||3||700||18)
        if (cleanedText.includes('||')) {
            const parts = cleanedText.split('||').map(p => p.trim());
            parts.forEach((part, index) => {
                const match = part.match(/^\s*(?:Question|Q\.?|)\s*(\d+)[\s.:\)-]+\s*(.*)$/i);
                if (match) {
                    const qNum = parseInt(match[1]);
                    answers[qNum] = match[2].trim();
                } else {
                    answers[index + 1] = part;
                }
            });
            return answers;
        }

        // Standard split by lines
        const lines = txtText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        lines.forEach(line => {
            // Match formats like "1. A", "Q1: 15", "1: 15", "1 - 15", "Question 1 - A"
            const match = line.match(/^\s*(?:Question|Q\.?|)\s*(\d+)[\s.:\)-]+\s*(.*)$/i);
            if (match) {
                const qNum = parseInt(match[1]);
                const ansVal = match[2].trim();
                answers[qNum] = ansVal;
            }
        });

        // Fallback: if no key-value matches are found, assume it is a simple ordered list of answers
        if (Object.keys(answers).length === 0 && lines.length > 0) {
            lines.forEach((line, index) => {
                answers[index + 1] = line.trim();
            });
        }

        return answers;
    }

    /**
     * Resolves a text answer value to the corresponding index in options
     */
    static resolveCorrectAnswer(ansVal, options) {
        if (!ansVal) return -1;

        const valLower = ansVal.toLowerCase();

        // 1. Check if it matches option letters (A, B, C, D)
        if (valLower === 'a' || valLower === 'option a') return 0;
        if (valLower === 'b' || valLower === 'option b') return 1;
        if (valLower === 'c' || valLower === 'option c') return 2;
        if (valLower === 'd' || valLower === 'option d') return 3;
        if (valLower === 'e' || valLower === 'option e') return 4;

        // 2. Check if the value is a direct match with one of the option texts
        for (let i = 0; i < options.length; i++) {
            const cleanOpt = options[i].toLowerCase().trim();
            if (cleanOpt === valLower) {
                return i;
            }
        }

        // 3. Check for option numbers (1, 2, 3, 4)
        const num = parseInt(ansVal);
        if (!isNaN(num) && num >= 1 && num <= options.length) {
            return num - 1;
        }

        return -1;
    }
}
