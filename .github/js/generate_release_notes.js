const { google } = require('googleapis');
const core = require('@actions/core');
const github = require('@actions/github');
const { execSync } = require('child_process');

(async () => {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const previousTag = process.env.previous_alpha_tag;
    let commitRange = '';
    if (previousTag) {
      commitRange = `${previousTag}..HEAD`;
    } else {
      commitRange = 'HEAD';
    }

    // Получение списка изменённых файлов
    let files = [];
    try {
      const output = execSync(`git diff --name-only ${commitRange}`).toString();
      files = output.trim().split('\n');
    } catch (error) {
      core.setFailed(`Failed to get changed files: ${error.message}`);
      return;
    }

    // Фильтрация файлов переводов
    const translationFiles = files.filter(file => file.includes('assets/') && file.includes('/lang/'));

    // Извлечение изменённых переводов модов и версий
    const modChanges = {};
    translationFiles.forEach(file => {
      const parts = file.split('/');
      const version = parts[1];
      const modIdIndex = parts.indexOf('assets') + 1;
      const modId = parts[modIdIndex];
      const langFile = parts.slice(modIdIndex + 1).join('/');

      if (!modChanges[modId]) {
        modChanges[modId] = new Set();
      }
      modChanges[modId].add(version);
    });

    // Подключение к БД
    const sheets = google.sheets('v4');

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const docId = '1kGGT2GGdG_Ed13gQfn01tDq2MZlVOC9AoiD1s3SDlZE';

    let modData = {};

    try {
      const response = await sheets.spreadsheets.values.get({
        auth,
        spreadsheetId: docId,
        range: 'db!A:I', // Лист «db»
      });

      const rows = response.data.values;
      if (rows.length) {
        // Заголовки: id, name, modrinthUrl, cfUrl, fallbackUrl
        const headers = rows[0];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const mod = {};
          for (let j = 0; j < headers.length; j++) {
            mod[headers[j]] = row[j];
          }
          modData[mod['id']] = mod;
        }
      } else {
        core.setFailed('В гугл-таблице нет данных');
        return;
      }
    } catch (error) {
      core.setFailed(`Ошибка доступа к гугл-таблице: ${error.message}`);
      return;
    }

    // Построение списка изменений

    // Заголовок
    const alphaNumber = parseInt(process.env.next_alpha, 10);
    let releaseNotes = `Это ${alphaNumber}-я альфа-версия всех переводов проекта.\n\n`;
    releaseNotes += `Про то, как выходят ранние версии проекта, можете прочитать [здесь](https://github.com/RushanM/Minecraft-Mods-Russian-Translation/blob/alpha/Памятки/Именование%20выпусков.md).\n\n`;

    // Изменения
    const changes = {};

    translationFiles.forEach(file => {
      const parts = file.split('/');
      const version = parts[1];
      const modIdIndex = parts.indexOf('assets') + 1;
      const modId = parts[modIdIndex];
      const langFile = parts.slice(modIdIndex + 1).join('/');

      const mod = modData[modId];
      if (mod) {
        let modName = mod['name'];
        let modUrl = mod['modrinthUrl'];
        if (!modUrl || modUrl === 'FALSE') {
          modUrl = mod['cfUrl'];
        }
        if (!modUrl || modUrl === 'FALSE') {
          modUrl = mod['fallbackUrl'];
        }

        // Определение языка
        let lang = '';
        if (file.includes('ru_ru')) {
          lang = 'русский';
        } else if (file.includes('tt_ru')) {
          lang = 'татарский';
        } else {
          lang = 'неизвестный язык';
        }

        const key = `${lang}-${modId}`;
        if (!changes[key]) {
          changes[key] = {
            lang: lang,
            modName: modName,
            modUrl: modUrl,
            versions: new Set(),
          };
        }
        changes[key].versions.add(version);
      }
    });

    if (Object.keys(changes).length === 0) {
      releaseNotes += 'В этой альфе нет изменений.';
    } else {
      const langs = new Set(Object.values(changes).map(change => change.lang));

      if (Object.keys(changes).length === 1) {
        const change = Object.values(changes)[0];
        releaseNotes += `**В этой альфе изменён ${change.lang} перевод [${change.modName}](${change.modUrl}) для Minecraft ${Array.from(change.versions).join(', ')}.**`;
      } else {
        releaseNotes += '**Изменения**\n\n';
        for (const changeKey in changes) {
          const change = changes[changeKey];
          releaseNotes += `* Изменён ${change.lang} перевод:\n`;
          releaseNotes += `* * [${change.modName}](${change.modUrl}) на Minecraft ${Array.from(change.versions).join(', ')};\n`;
        }
      }
    }

    core.setOutput('release_notes', releaseNotes);

  } catch (error) {
    core.setFailed(error.message);
  }
})();