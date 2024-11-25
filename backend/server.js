const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mqttClient = require('./mqtt'); // Import mqttClient từ mqtt.js
const db = require('./database'); // Sử dụng kết nối từ file database.js

const app = express();
const PORT = 3001;
const HIST_PORT = 3002;  // Cổng mới cho lịch sử trạng thái quạt

// Biến lưu trữ trạng thái từ các topic MQTT
const fanData = {
    mode: 'auto',        // Chế độ hiện tại
    control: 'off',      // Trạng thái quạt (on/off)
    threshold: 25,       // Ngưỡng nhiệt độ
    temperature: 0,      // Nhiệt độ hiện tại
    humidity: 0,         // Độ ẩm hiện tại
};

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Lắng nghe thông điệp từ MQTT broker
mqttClient.on('message', (topic, message) => {
    const payload = message.toString();
    let isChanged = false;  // Biến kiểm tra xem có thay đổi hay không

    switch (topic) {
        case 'fan/mode':
            if (fanData.mode !== payload) {
                fanData.mode = payload;
                console.log(`Fan mode updated: ${payload}`);
                isChanged = true;  // Đánh dấu đã thay đổi
            }
            break;

        case 'fan/control':
            if (fanData.control !== payload) {
                fanData.control = payload;
                console.log(`Fan control updated: ${payload}`);
                isChanged = true;  // Đánh dấu đã thay đổi
            }
            break;

        case 'fan/threshold':
            const thresholdValue = parseFloat(payload);
            if (fanData.threshold !== thresholdValue) {
                fanData.threshold = thresholdValue;
                console.log(`Threshold updated: ${payload}`);
                isChanged = true;  // Đánh dấu đã thay đổi
            }
            break;

        case 'fan/update':
            try {
                const updateData = JSON.parse(payload);
                if (updateData.mode && updateData.mode !== fanData.mode) {
                    fanData.mode = updateData.mode;
                    isChanged = true;  // Đánh dấu đã thay đổi
                }
                if (updateData.state && updateData.state !== fanData.control) {
                    fanData.control = updateData.state;
                    isChanged = true;  // Đánh dấu đã thay đổi
                }
                if (updateData.threshold && updateData.threshold !== fanData.threshold) {
                    fanData.threshold = updateData.threshold;
                    isChanged = true;  // Đánh dấu đã thay đổi
                }
                if (updateData.temperature !== undefined && updateData.temperature !== fanData.temperature) {
                    fanData.temperature = updateData.temperature;
                }
                if (updateData.humidity !== undefined && updateData.humidity !== fanData.humidity) {
                    fanData.humidity = updateData.humidity;
                }

                console.log('Fan status updated:', fanData);
            } catch (err) {
                console.error('Invalid JSON in fan/update:', err);
            }
            break;

        default:
            console.warn(`Unhandled topic: ${topic}`);
    }

    // Chỉ lưu nếu có sự thay đổi
    if (isChanged) {
        saveDeviceStatusHistory();  // Lưu trạng thái vào lịch sử
    }
});

function saveDeviceStatusHistory() {
    let { control, mode, threshold, temperature, humidity } = fanData;
    const deviceId = 'esp32'; // ID thiết bị của bạn

    const query = `INSERT INTO device_status_history (device_id, status, mode, threshold, temperature, humidity) 
                   VALUES (?, ?, ?, ?, ?, ?)`;
    const values = [deviceId, control, mode, threshold, temperature, humidity];

    db.query(query, values, (err, results) => {
        if (err) {
            console.error('Error inserting device status into history:', err);
        } else {
            console.log('Device status history saved successfully');
        }
    });
}

// API GET: Lấy toàn bộ dữ liệu fanData
app.get('/api/fanData', (req, res) => {
    res.json(fanData);
});

// API POST: Thay đổi chế độ quạt qua MQTT
app.post('/api/fanData', (req, res) => {
    const { mode } = req.body;

    if (!mode || (mode !== 'auto' && mode !== 'manual')) {
        return res.status(400).json({ message: 'Invalid mode' });
    }

    mqttClient.publish('fan/mode', mode, (err) => {
        if (err) {
            console.error('Failed to publish mode:', err);
            return res.status(500).json({ message: 'Failed to update mode' });
        }

        fanData.mode = mode; // Cập nhật mode local
        res.status(200).json({ message: 'Mode updated successfully', mode });
    });
});

// API POST: Thay đổi ngưỡng nhiệt độ qua MQTT
app.post('/api/changeThreshold', (req, res) => {
  const { threshold } = req.body;

  // Kiểm tra xem ngưỡng nhiệt độ có hợp lệ hay không (kiểu số, không phải NaN)
  if (threshold === undefined || isNaN(threshold)) {
      return res.status(400).json({ message: 'Invalid threshold value' });
  }

  // Đảm bảo giá trị threshold là số thực
  const thresholdValue = parseFloat(threshold);
  
  if (isNaN(thresholdValue)) {
      return res.status(400).json({ message: 'Threshold must be a valid number' });
  }

  // Gửi ngưỡng nhiệt độ mới về MQTT broker
  mqttClient.publish('fan/threshold', thresholdValue.toString(), (err) => {
      if (err) {
          console.error('Failed to publish threshold:', err);
          return res.status(500).json({ message: 'Failed to update threshold' });
      }

      // Cập nhật ngưỡng nhiệt độ tại backend (local)
      fanData.threshold = thresholdValue;
      
      // Trả về thông báo thành công
      res.status(200).json({ message: 'Threshold updated successfully', threshold: thresholdValue });
  });
});

// API POST: Thay đổi trạng thái quạt qua MQTT (bật/tắt quạt)
app.post('/api/toggleFan', (req, res) => {
    const { control } = req.body;

    if (!control || (control !== 'on' && control !== 'off')) {
        return res.status(400).json({ message: 'Invalid control state' });
    }

    mqttClient.publish('fan/control', control, (err) => {
        if (err) {
            console.error('Failed to publish fan control:', err);
            return res.status(500).json({ message: 'Failed to update fan control' });
        }

        fanData.control = control; // Cập nhật control local
        res.status(200).json({ message: 'Fan control updated successfully', control });
    });
});

// API GET: Lấy lịch sử trạng thái quạt từ cơ sở dữ liệu
app.get('/api/statusHistory', (req, res) => {
  const query = 'SELECT * FROM device_status_history ORDER BY timestamp DESC';

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching history:', err);
      return res.status(500).json({ message: 'Error fetching history' });
    }

    // Định dạng ngày giờ và dịch chế độ
    const formattedResults = results.map(row => {
      // Định dạng ngày giờ
      const formattedTimestamp = new Date(row.timestamp).toLocaleString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      // Dịch chế độ
      const translatedMode = row.mode === 'auto' ? 'Tự động' : 'Thủ công';
      const translatedStatus = row.status === 'on' ? 'Bật' : 'Tắt';

      // Loại bỏ ngưỡng nhiệt độ nếu chế độ là "manual"
      const threshold = row.mode === 'manual' ? null : row.threshold;

      // Trả về dữ liệu đã định dạng
      return {
        ...row,
        timestamp: formattedTimestamp,
        mode: translatedMode,
        status: translatedStatus,
        threshold: threshold, // Ngưỡng nhiệt độ sẽ là null nếu chế độ là "manual"
      };
    });

    res.json(formattedResults); // Trả về dữ liệu đã định dạng
  });
});



// Khởi động server cho cổng chính (3001)
app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
});

// Khởi động server cho cổng lịch sử (3002)
app.listen(HIST_PORT, () => {
    console.log(`History API server is running on http://localhost:${HIST_PORT}`);
});
