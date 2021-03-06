#ifndef _COMMON_H_
#define _COMMON_H_

#include "application.h"

#define MANAGE_WIFI true // whether to switch off wifi in batch mode

#define EMG_SENSOR_PIN A0
#define BUZZER_PIN A4
#define BUTTON1_PIN D2
#define BUTTON2_PIN D3
#define FAST_MODE_LED_PIN D7

#define USE_EMG false

#define USE_BUTTONS false

#define USE_IMU_1_BNO055 true
#define USE_IMU_2_MMA8452 true

#define DEBUG_LOG(x) serial_log(__func__, __LINE__, x)

void serial_log(const char *func, int line, String message);


#endif // _COMMON_H_
