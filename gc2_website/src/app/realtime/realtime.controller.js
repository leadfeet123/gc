(function() {
  'use strict';

  angular
    .module('gc2Website')
    .controller('RealtimeController', RealtimeController);

  /** @ngInject */
  function RealtimeController($timeout, $log, $scope, $rootScope, PubNub) {
    var vm = this;

    
    vm.channel = "sleep-track-data-luc";
    
   
    vm.emgGaugeOptions = {
        chart: {
            type: 'solidgauge'
        },

        title: null,

        pane: {
            center: ['50%', '85%'],
            size: '140%',
            startAngle: -90,
            endAngle: 90,
            background: {
                backgroundColor: (Highcharts.theme && Highcharts.theme.background2) || '#EEE',
                innerRadius: '60%',
                outerRadius: '100%',
                shape: 'arc'
            }
        },

        tooltip: {
            enabled: false
        },

        // the value axis
        yAxis: {
            min: 0,
            max: 2000,        
            stops: [
                [0.1, '#55BF3B'], // green
                [0.5, '#DDDF0D'], // yellow
                [0.9, '#DF5353'] // red
            ],
            lineWidth: 0,
            minorTickInterval: null,
            tickPixelInterval: 400,
            tickWidth: 0,
            title: {
                y: 30
            },
            labels: {
                y: 16
            }
        },

        plotOptions: {
            solidgauge: {
                dataLabels: {
                    y: 5,
                    borderWidth: 0,
                    useHTML: true
                }
            }
        },
        
        series: [{
            name: 'Speed',
            data: [80],
            dataLabels: {
                format: '<div style="text-align:center"><span style="font-size:25px;color:' +
                    ((Highcharts.theme && Highcharts.theme.contrastTextColor) || 'black') + '">{y}</span><br/>'
            },
        }]        
        
    };
    
   
    function update_emg_value(emg_value) {
        var chart = $('#container-emg').highcharts();

        if (chart) {
            var point = chart.series[0].points[0];
            point.update(emg_value);
        }        
    }
    
    function init() {
        $log.info("RealTimeController init");
        
        // initialize chart
        $log.info("container emg: ", $('#container-emg'));
        $log.info("gauge options: ", vm.emgGaugeOptions);
        $('#container-emg').highcharts(vm.emgGaugeOptions);
                
        PubNub.init({
            publish_key: 'pub-c-879cf9bb-46af-4bf1-8dca-e011ea412cd2',
            subscribe_key: 'sub-c-cba703c8-7b42-11e3-9cac-02ee2ddab7fe'
        });
        
        subscribe();
    }
    
    function subscribe() {
        PubNub.ngSubscribe({ channel: vm.channel });
    }
    
    
    $rootScope.$on(PubNub.ngMsgEv(vm.channel), function(event, payload) {
        // payload contains message, channel, env...
        $log.info("payload: ", payload.message);
        update_emg_value(payload.message.emg_value);
    })    
    
    init();
    
  }
})();